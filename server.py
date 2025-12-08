#!/usr/bin/env python3

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import math
import random
import struct
import time
from collections import deque
from typing import Deque, Dict, List, Optional, Tuple

try:
    import websockets
    from websockets.server import WebSocketServerProtocol
except Exception as e:
    raise SystemExit(
        "This server requires the 'websockets' package. Install with: pip install websockets"
    ) from e

try:
    import asyncpg
except Exception:
    asyncpg = None

# Defaults
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765

RING_CAPACITY_DEFAULT = 200_000
HISTORY_CHUNK_DEFAULT = 4096
LIVE_BATCH_DEFAULT = 512
HEARTBEAT_SEC_DEFAULT = 5

TOTAL_SAMPLES_DEFAULT = 4000

SESSION_MS_DEFAULT = 23_400_000  # 6.5h
TICK_DT_MS_DEFAULT = 25
BAR_INTERVALS_DEFAULT = "10000,30000"

PRICE_MODEL_DEFAULT = "sine"
SINE_PERIOD_SEC_DEFAULT = 60.0
SINE_AMP_DEFAULT = 2.0
SINE_NOISE_DEFAULT = 0.05
BASE_PRICE_DEFAULT = 100.0
RW_DRIFT_DEFAULT = 0.0
RW_VOL_DEFAULT = 0.25

STRAT_RATE_PER_MIN_DEF = 6.0
STRAT_HOLD_BARS_DEF = 5
STRAT_MAX_OPEN_DEF = 3

LIVE_FLUSH_MS_DEFAULT = 20  # live sender flush interval (ms)


def now_ms() -> int:
    return int(time.time() * 1000)


def chunked(seq_list: List[dict], n: int):
    for i in range(0, len(seq_list), n):
        yield seq_list[i : i + n]


def ns_to_ms(ns: int) -> int:
    return int(ns // 1_000_000)


def parse_iso_to_ns(s: str) -> int:
    dt = datetime.datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    epoch = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
    return int((dt - epoch).total_seconds() * 1_000_000_000)


# ---------------------------------------------------------------------------
# Ring + playback
# ---------------------------------------------------------------------------


class FeedRun:
    """
    A single logical feed "run".

    It owns:
      - A ring buffer of samples (streaming buffer).
      - Global seq + per-series series_seq numbering.
      - Completion markers (done/final_seq) for finite runs.
    """

    def __init__(self, ring_capacity: int, live_batch: int):
        self.ring: Deque[dict] = deque(maxlen=ring_capacity)
        self.ring_capacity = int(ring_capacity)
        self.live_batch = int(live_batch)

        self.lock = asyncio.Lock()
        self.new_event = asyncio.Event()

        self.next_seq = 1
        self.final_seq: Optional[int] = None
        self.done = False

        # per-series sequence counters
        self._series_next_seq: Dict[str, int] = {}

    # ---- ring helpers ----
    def min_seq(self) -> int:
        if not self.ring:
            return self.next_seq
        return self.next_seq - len(self.ring)

    def last_seq(self) -> int:
        return self.next_seq - 1

    def _append(self, sample: dict):
        """
        Append a sample to the streaming ring, assigning global seq and per-series series_seq.
        The input sample must *not* contain 'seq' or 'series_seq'; they will be set here.
        """
        sid = sample.get("series_id")
        if sid:
            sseq = self._series_next_seq.get(sid, 1)
            sample["series_seq"] = sseq
            self._series_next_seq[sid] = sseq + 1

        sample["seq"] = self.next_seq
        self.next_seq += 1

        self.ring.append(sample)
        self.new_event.set()

    def get_range(self, start_seq: int, end_seq: int) -> List[dict]:
        if start_seq > end_seq:
            return []
        base = self.min_seq()
        last = self.last_seq()
        start_seq = max(start_seq, base)
        end_seq = min(end_seq, last)
        if start_seq > end_seq:
            return []
        start_idx = start_seq - base
        end_idx = end_seq - base
        lst = list(self.ring)
        return [lst[i] for i in range(start_idx, end_idx + 1)]

    async def wait_for_new_after(self, seq: int, timeout: Optional[float] = None) -> bool:
        if self.last_seq() > seq:
            return True
        try:
            self.new_event.clear()
            await asyncio.wait_for(self.new_event.wait(), timeout)
            return self.last_seq() > seq
        except asyncio.TimeoutError:
            return False


async def playback_from_memory(
        run: FeedRun,
        samples: List[dict],
        emit_sps: float,
        label: str = "playback",
):
    """
    Generic playback loop: push `samples` into `run` at approx `emit_sps` samples/sec.

    - If emit_sps <= 0, emits as fast as possible (cooperatively).
    - Marks run.done + run.final_seq when finished.
    """
    n = len(samples)
    if n == 0:
        run.done = True
        run.final_seq = run.last_seq()
        run.new_event.set()
        print(f"[{label}] nothing to play (0 samples)")
        return

    print(
        f"[{label}] starting playback: samples={n}, emit_sps="
        f"{emit_sps if emit_sps > 0 else 'unpaced'}"
    )

    if emit_sps <= 0:
        # Unpaced / as-fast-as-possible, but yield occasionally.
        batch_size = max(1, run.live_batch * 4)
        idx = 0
        while idx < n:
            end = min(idx + batch_size, n)
            for s in samples[idx:end]:
                run._append(dict(s))
            idx = end
            await asyncio.sleep(0)  # cooperative yield
    else:
        last_wall = time.time()
        carry = 0.0
        idx = 0
        min_sleep = 0.001
        while idx < n:
            now = time.time()
            dt = now - last_wall
            last_wall = now
            carry += emit_sps * dt
            to_emit = int(carry)
            if to_emit <= 0:
                await asyncio.sleep(min_sleep)
                continue
            carry -= to_emit
            end = min(idx + to_emit, n)
            for s in samples[idx:end]:
                run._append(dict(s))
            idx = end
            await asyncio.sleep(min_sleep)

    run.done = True
    run.final_seq = run.last_seq()
    run.new_event.set()
    print(f"[{label}] done: final_seq={run.final_seq}, sent_samples={n}")


# ---------------------------------------------------------------------------
# Synthetic dataset builder
# ---------------------------------------------------------------------------


class SyntheticBuilder:
    """
    Pure in‑memory synthetic data generator.

    Responsibilities:
      - Generate ticks based on a price model (sine or random‑walk).
      - Maintain per-window SMA buffers for indicators.
      - Maintain bar close times for each bar interval.
      - Generate simple synthetic strategy signals/markers/pnl.
      - Produce a flat list of samples (no seq / series_seq).
    """

    def __init__(
            self,
            mode: str,
            instrument: str,
            session_ms: int,
            tick_dt_ms: int,
            bar_intervals_ms: List[int],
            indicator_windows: List[int],
            *,
            price_model: str = PRICE_MODEL_DEFAULT,
            base_price: float = BASE_PRICE_DEFAULT,
            sine_period_sec: float = SINE_PERIOD_SEC_DEFAULT,
            sine_amp: float = SINE_AMP_DEFAULT,
            sine_noise: float = SINE_NOISE_DEFAULT,
            rw_drift: float = RW_DRIFT_DEFAULT,
            rw_vol: float = RW_VOL_DEFAULT,
            seed: Optional[int] = None,
            strategy_id: str = "alpha",
            strategy_rate_per_min: float = STRAT_RATE_PER_MIN_DEF,
            strategy_hold_bars: int = STRAT_HOLD_BARS_DEF,
            strategy_max_open: int = STRAT_MAX_OPEN_DEF,
    ):
        self.mode = mode
        self.instrument = instrument
        self.session_ms = max(1, int(session_ms))
        self.tick_dt_ms = max(1, int(tick_dt_ms))
        self.bar_intervals = sorted(set(int(x) for x in bar_intervals_ms)) or [10_000]

        self.price_model = price_model
        self.base_price = float(base_price)
        self.sine_period_ms = max(1, int(float(sine_period_sec) * 1000))
        self.sine_amp = float(sine_amp)
        self.sine_noise = float(sine_noise)
        self.rw_drift = float(rw_drift)
        self.rw_vol = float(rw_vol)

        self.indicator_windows = sorted(set(int(w) for w in indicator_windows if int(w) > 0)) or [10]
        self._indicator_buffers: Dict[int, Deque[float]] = {
            w: deque(maxlen=w) for w in self.indicator_windows
        }

        self.strategy_id = str(strategy_id)
        self.strategy_rate_per_min = float(strategy_rate_per_min)
        self.strategy_hold_bars = int(strategy_hold_bars)
        self.strategy_max_open = int(strategy_max_open)
        self._open_trades: List[dict] = []
        self._pnl_cum = 0.0
        self._last_signal_ms: Optional[int] = None

        self._logical_start_ms = now_ms()
        self._current_ms = self._logical_start_ms
        self._price = float(self.base_price)
        self._rw_initialized = False

        # For bars
        self._next_bar_close: Dict[int, int] = {}
        for iv in self.bar_intervals:
            base = ((self._logical_start_ms // iv) + 1) * iv
            self._next_bar_close[iv] = base

        self._tick_index = 0

        if seed is not None:
            random.seed(seed)

    # ---- price / indicators / bars ----
    def _calc_sine_price(self, t_ms: int) -> float:
        phase = (t_ms - self._logical_start_ms) * (2.0 * math.pi / self.sine_period_ms)
        noise = (
            random.uniform(-self.sine_noise, self.sine_noise)
            if self.sine_noise > 0
            else 0.0
        )
        return self.base_price + self.sine_amp * math.sin(phase) + noise

    def _next_price(self, t_ms: int) -> float:
        if self.price_model == "sine":
            self._price = self._calc_sine_price(t_ms)
        else:
            if not self._rw_initialized:
                self._price = self.base_price
                self._rw_initialized = True
            step = random.gauss(self.rw_drift, self.rw_vol)
            self._price += step
        return self._price

    def _update_indicators(self, price: float) -> Dict[int, Optional[float]]:
        out: Dict[int, Optional[float]] = {}
        for w, buf in self._indicator_buffers.items():
            buf.append(float(price))
            if len(buf) < w:
                out[w] = None
            else:
                out[w] = sum(buf) / len(buf)
        return out

    def _synthesize_bar(self) -> Tuple[float, float, float, float]:
        c = round(self._price + random.uniform(-0.02, 0.02), 5)
        o = round(c + random.uniform(-0.05, 0.05), 5)
        h = round(max(o, c) + random.uniform(0.01, 0.06), 5)
        l = round(min(o, c) - random.uniform(0.01, 0.06), 5)
        return (o, h, l, c)

    # ---- strategy helpers ----
    def _process_exits(self, t_ms: int, samples: List[dict]):
        if not self._open_trades:
            return
        still_open: List[dict] = []
        for tr in self._open_trades:
            if t_ms >= tr["exit_t"]:
                exit_px = self._price
                samples.append(
                    {
                        "series_id": f"{self.instrument}:strategy:{self.strategy_id}:markers",
                        "t_ms": tr["exit_t"],
                        "payload": {
                            "strategy": self.strategy_id,
                            "side": tr["side"],
                            "tag": "exit",
                            "price": round(exit_px, 5),
                            "qty": tr["qty"],
                        },
                    }
                )
                mult = +1.0 if tr["side"] == "long" else -1.0
                realized = (exit_px - tr["entry_px"]) * mult * tr["qty"]
                self._pnl_cum += realized
                samples.append(
                    {
                        "series_id": f"{self.instrument}:strategy:{self.strategy_id}:pnl",
                        "t_ms": tr["exit_t"],
                        "payload": {"value": round(self._pnl_cum, 2)},
                    }
                )
            else:
                still_open.append(tr)
        self._open_trades = still_open

    def _maybe_emit_strategy(self, t_ms: int, tick_hz: float, samples: List[dict]):
        self._process_exits(t_ms, samples)
        if self.strategy_rate_per_min <= 0 or tick_hz <= 0:
            return
        if len(self._open_trades) >= self.strategy_max_open:
            return

        target_interval_ms = 60_000.0 / max(self.strategy_rate_per_min, 0.1)
        min_gap_ms = max(target_interval_ms * 0.5, 1000.0)
        if self._last_signal_ms is not None:
            if (t_ms - self._last_signal_ms) < min_gap_ms:
                return

        # Per-tick probability to hit the desired average rate.
        p = (self.strategy_rate_per_min / 60.0) / tick_hz
        if random.random() >= p:
            return

        side = "long" if random.random() < 0.5 else "short"
        qty = 1
        entry_px = self._price
        reason = "synthetic"

        samples.append(
            {
                "series_id": f"{self.instrument}:strategy:{self.strategy_id}:signals",
                "t_ms": t_ms,
                "payload": {
                    "strategy": self.strategy_id,
                    "side": side,
                    "desired_qty": qty,
                    "price": round(entry_px, 5),
                    "reason": reason,
                },
            }
        )
        samples.append(
            {
                "series_id": f"{self.instrument}:strategy:{self.strategy_id}:markers",
                "t_ms": t_ms,
                "payload": {
                    "strategy": self.strategy_id,
                    "side": side,
                    "tag": "entry",
                    "price": round(entry_px, 5),
                    "qty": qty,
                },
            }
        )

        iv = self.bar_intervals[0]
        exit_at = ((t_ms // iv) + 1) * iv + max(0, self.strategy_hold_bars - 1) * iv
        self._open_trades.append(
            {
                "side": side,
                "qty": qty,
                "entry_t": t_ms,
                "exit_t": exit_at,
                "entry_px": entry_px,
            }
        )
        self._last_signal_ms = t_ms

    # ---- main generation ----
    def build(self, total_samples_cap: int) -> List[dict]:
        """
        Build a synthetic dataset and return a list of samples (no seq/series_seq).
        """
        samples: List[dict] = []

        # Number of ticks:
        #  - session mode: derived from session_ms / tick_dt_ms
        #  - quick mode: derived from total_samples_cap (if >0) or a small default clip
        if self.mode == "session":
            max_ticks = int(self.session_ms // self.tick_dt_ms)
            if max_ticks <= 0:
                max_ticks = 1
        else:  # quick
            if total_samples_cap > 0:
                approx_fanout = 1.0 + len(self.indicator_windows)
                max_ticks = max(1, int(math.ceil(total_samples_cap / approx_fanout)))
            else:
                max_ticks = 4000  # small sanity clip

        end_ms = self._logical_start_ms + self.session_ms

        tick_hz = 1000.0 / float(self.tick_dt_ms)
        total_cap = max(0, int(total_samples_cap))

        for i in range(max_ticks):
            t_ms = self._logical_start_ms + i * self.tick_dt_ms
            self._current_ms = t_ms
            if self.mode == "session" and t_ms > end_ms:
                break

            self._tick_index += 1
            price = self._next_price(t_ms)
            vol = max(1.0, random.random() * 2.0)

            # Tick
            samples.append(
                {
                    "series_id": f"{self.instrument}:ticks",
                    "t_ms": t_ms,
                    "payload": {"price": round(price, 5), "volume": round(vol, 3)},
                }
            )
            if total_cap and len(samples) >= total_cap:
                break

            # Indicators
            ind_vals = self._update_indicators(price)
            for w, val in ind_vals.items():
                samples.append(
                    {
                        "series_id": f"{self.instrument}:sma_{w}",
                        "t_ms": t_ms,
                        "payload": {"value": None if val is None else round(val, 5)},
                    }
                )
                if total_cap and len(samples) >= total_cap:
                    break
            if total_cap and len(samples) >= total_cap:
                break

            # Bars
            for iv in self.bar_intervals:
                if t_ms >= self._next_bar_close[iv]:
                    o, h, l, c = self._synthesize_bar()
                    samples.append(
                        {
                            "series_id": f"{self.instrument}:ohlc_time:{iv}",
                            "t_ms": self._next_bar_close[iv],
                            "payload": {"o": o, "h": h, "l": l, "c": c},
                        }
                    )
                    self._next_bar_close[iv] += iv
                    if total_cap and len(samples) >= total_cap:
                        break
            if total_cap and len(samples) >= total_cap:
                break

            # Strategy
            self._maybe_emit_strategy(t_ms, tick_hz=tick_hz, samples=samples)
            if total_cap and len(samples) >= total_cap:
                break

        print(
            f"[build] synthetic {self.mode.upper()} dataset: ticks≈{self._tick_index}, "
            f"samples={len(samples)}"
        )
        return samples


def build_synthetic_dataset(args) -> List[dict]:
    """
    Build synthetic dataset for one or more instruments.
    Returns combined samples from all instruments, sorted by t_ms.
    """
    all_samples: List[dict] = []
    
    # Use different base prices for different instruments to make them visually distinct
    base_prices = {
        "ESU5": 6000.0,
        "MESU5": 3000.0,
        "ES.c.0": 100.0,
    }
    
    # Distribute total_samples across instruments (if specified)
    # In session mode: ignore total_samples and let each instrument generate full session
    # In quick mode: use total_samples if specified, otherwise let each generate full dataset
    if args.mode == "session":
        # Session mode: generate full session for each instrument (ignore total_samples)
        samples_per_instrument = 0
    elif args.total_samples > 0:
        # Quick mode with total_samples specified: distribute across instruments
        samples_per_instrument = args.total_samples // len(args.instruments)
    else:
        # Quick mode without total_samples: unlimited per instrument
        samples_per_instrument = 0
    
    # Build dataset for each instrument
    for idx, instrument in enumerate(args.instruments):
        # Use different seeds for each instrument to get different price patterns
        instrument_seed = args.seed + idx if args.seed is not None else None
        
        # Use instrument-specific base price if available, otherwise use default
        instrument_base_price = base_prices.get(instrument, args.base_price + (idx * 10.0))
        
        builder = SyntheticBuilder(
            mode=args.mode,
            instrument=instrument,
            session_ms=args.session_ms,
            tick_dt_ms=args.tick_dt_ms,
            bar_intervals_ms=args.bar_intervals,
            indicator_windows=args.indicator_windows_list,
            price_model=args.price_model,
            base_price=instrument_base_price,
            sine_period_sec=args.sine_period_sec,
            sine_amp=args.sine_amp,
            sine_noise=args.sine_noise,
            rw_drift=args.rw_drift,
            rw_vol=args.rw_vol,
            seed=instrument_seed,
            strategy_id=args.strategy_id,
            strategy_rate_per_min=args.strategy_rate_per_min,
            strategy_hold_bars=args.strategy_hold_bars,
            strategy_max_open=args.strategy_max_open,
        )
        
        # Use distributed sample cap per instrument, or 0 for unlimited
        instrument_samples = builder.build(total_samples_cap=samples_per_instrument)
        all_samples.extend(instrument_samples)
    
    # Sort all samples by t_ms to interleave them chronologically
    all_samples.sort(key=lambda s: s.get("t_ms", 0))
    
    # Only cap combined samples in quick mode (not in session mode)
    # In session mode, we want the full session for all instruments
    if args.mode != "session" and args.total_samples > 0 and len(all_samples) > args.total_samples:
        all_samples = all_samples[:args.total_samples]
    
    print(
        f"[build] synthetic {args.mode.upper()} dataset: "
        f"instruments={args.instruments}, total_samples={len(all_samples)}"
    )
    
    return all_samples


# ---------------------------------------------------------------------------
# WebSocket server
# ---------------------------------------------------------------------------


class WSServer:
    def __init__(self, args, cfg: Optional[dict]):
        self.args = args
        self.cfg = cfg
        self.run: Optional[FeedRun] = None
        self._run_lock = asyncio.Lock()

    async def handler(self, ws: WebSocketServerProtocol):
        """
        WebSocket handler implementing: resume → init_begin/history/delta/init_complete → live.
        """
        # Expect first frame: {"type":"resume","from_seq":N}
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=15.0)
        except asyncio.TimeoutError:
            await self._send(
                ws,
                {"type": "error", "reason": "first frame must be resume (timeout)"},
            )
            await ws.close()
            return

        try:
            msg = json.loads(raw)
        except Exception:
            await self._send(ws, {"type": "error", "reason": "invalid JSON for first frame"})
            await ws.close()
            return

        if not isinstance(msg, dict) or msg.get("type") != "resume":
            await self._send(ws, {"type": "error", "reason": "first frame must be resume"})
            await ws.close()
            return

        from_seq = int(msg.get("from_seq") or 1)

        async with self._run_lock:
            run = self.run
        if run is None:
            await self._send(ws, {"type": "error", "reason": "no active run"})
            await ws.close()
            return

        min_seq = run.min_seq()
        wm_seq = run.last_seq()
        start = max(from_seq, min_seq)
        resume_truncated = from_seq < min_seq

        await self._send(
            ws,
            {
                "type": "init_begin",
                "wm_seq": wm_seq,
                "min_seq": min_seq,
                "ring_capacity": run.ring_capacity,
            },
        )

        # History: [start .. wm_seq]
        if start <= wm_seq:
            history = run.get_range(start, wm_seq)
            for batch in chunked(history, self.args.history_chunk):
                await self._send(ws, {"type": "history", "samples": batch})

        # Delta: anything appended while we were sending history
        delta_end = run.last_seq()
        if delta_end > wm_seq:
            delta = run.get_range(wm_seq + 1, delta_end)
            for batch in chunked(delta, self.args.history_chunk):
                await self._send(ws, {"type": "delta", "samples": batch})

        await self._send(
            ws,
            {
                "type": "init_complete",
                "resume_from": delta_end,
                "resume_truncated": resume_truncated,
            },
        )

        hb_task = asyncio.create_task(self._heartbeat_loop(ws))
        live_task = asyncio.create_task(self._live_loop(ws, run, after_seq=delta_end))

        done, pending = await asyncio.wait(
            {hb_task, live_task}, return_when=asyncio.FIRST_COMPLETED
        )
        for t in pending:
            t.cancel()
        try:
            await ws.close()
        except Exception:
            pass

    # ---- binary/text encoding -------------------------------------------------

    def _payload_kind(self, sample: dict) -> str:
        """
        Classify payload shape for binary encoding.

        Returns one of: 'tick','scalar','ohlc','signal','marker','pnl'.
        """
        sid = str(sample.get("series_id", ""))
        payload = sample.get("payload") or {}
        if sid.endswith(":ticks"):
            return "tick"
        if ":ohlc_time:" in sid:
            return "ohlc"
        if ":strategy:" in sid:
            if sid.endswith(":signals"):
                return "signal"
            if sid.endswith(":markers"):
                return "marker"
            if sid.endswith(":pnl"):
                return "pnl"
        if "value" in payload:
            return "scalar"
        return "tick"

    def _encode_samples_binary(self, frame_type: str, samples: List[dict]) -> bytes:
        """
        Compact binary encoding for history/delta/live frames.

        Layout (big-endian):

        frame_header:
            u8   frame_type_code   (1=history,2=delta,3=live)
            u32  sample_count

        per-sample:
            f64  seq
            f64  series_seq
            f64  t_ms
            u8   series_id_len (L)
            Lb   series_id UTF-8
            u8   payload_type  (1=tick,2=scalar(value),3=ohlc,4=signal,5=marker,6=pnl)
            ...  payload fields (see below)

        payload type 1 (tick):
            f64  price
            f64  volume

        payload type 2 (scalar):
            f64  value (NaN encodes None)

        payload type 3 (ohlc):
            f64  o
            f64  h
            f64  l
            f64  c

        payload type 4 (signal):
            u8   strategy_len (Ns)
            Nsb  strategy UTF-8
            u8   side_char ('L' or 'S')
            i32  desired_qty
            f64  price
            u8   reason_len (Nr)
            Nrb  reason UTF-8

        payload type 5 (marker):
            u8   strategy_len (Ns)
            Nsb  strategy UTF-8
            u8   side_char ('L' or 'S')
            u8   tag_len (Nt)
            Ntb  tag UTF-8
            f64  price
            i32  qty

        payload type 6 (pnl):
            f64  value
        """
        if not samples:
            return b""
        frame_code = {"history": 1, "delta": 2, "live": 3}.get(frame_type, 0)
        buf = bytearray()
        buf.append(frame_code & 0xFF)
        buf.extend(struct.pack(">I", len(samples)))
        for s in samples:
            seq = float(s.get("seq", 0))
            series_seq = float(s.get("series_seq", 0))
            t_ms = float(s.get("t_ms", 0))
            sid = str(s.get("series_id", ""))
            sid_bytes = sid.encode("utf-8")
            if len(sid_bytes) > 255:
                sid_bytes = sid_bytes[:255]
            buf.extend(struct.pack(">ddd", seq, series_seq, t_ms))
            buf.append(len(sid_bytes))
            buf.extend(sid_bytes)
            kind = self._payload_kind(s)
            payload = s.get("payload") or {}
            if kind == "tick":
                buf.append(1)
                price = float(payload.get("price", 0.0))
                vol = float(payload.get("volume", 0.0))
                buf.extend(struct.pack(">dd", price, vol))
            elif kind == "scalar":
                buf.append(2)
                v = payload.get("value")
                if v is None:
                    v = float("nan")
                buf.extend(struct.pack(">d", float(v)))
            elif kind == "ohlc":
                buf.append(3)
                o = float(payload.get("o", 0.0))
                h = float(payload.get("h", 0.0))
                l = float(payload.get("l", 0.0))
                c = float(payload.get("c", 0.0))
                buf.extend(struct.pack(">dddd", o, h, l, c))
            elif kind == "signal":
                buf.append(4)
                strat = str(payload.get("strategy", ""))
                strat_bytes = strat.encode("utf-8")[:255]
                side = payload.get("side", "long")
                side_code = b"L" if side == "long" else b"S"
                qty = int(payload.get("desired_qty", 0))
                price = float(payload.get("price", 0.0))
                reason = str(payload.get("reason", ""))
                reason_bytes = reason.encode("utf-8")[:255]
                buf.append(len(strat_bytes))
                buf.extend(strat_bytes)
                buf.extend(side_code)
                buf.extend(struct.pack(">i", qty))
                buf.extend(struct.pack(">d", price))
                buf.append(len(reason_bytes))
                buf.extend(reason_bytes)
            elif kind == "marker":
                buf.append(5)
                strat = str(payload.get("strategy", ""))
                strat_bytes = strat.encode("utf-8")[:255]
                side = payload.get("side", "long")
                side_code = b"L" if side == "long" else b"S"
                tag = str(payload.get("tag", ""))
                tag_bytes = tag.encode("utf-8")[:255]
                price = float(payload.get("price", 0.0))
                qty = int(payload.get("qty", 0))
                buf.append(len(strat_bytes))
                buf.extend(strat_bytes)
                buf.extend(side_code)
                buf.append(len(tag_bytes))
                buf.extend(tag_bytes)
                buf.extend(struct.pack(">d", price))
                buf.extend(struct.pack(">i", qty))
            elif kind == "pnl":
                buf.append(6)
                v = float(payload.get("value", 0.0))
                buf.extend(struct.pack(">d", v))
            else:
                buf.append(0)  # unknown payload type, no extra fields
        return bytes(buf)

    async def _send(self, ws: WebSocketServerProtocol, obj: dict):
        fmt = getattr(self.args, "ws_format", "text")
        if (
                fmt == "binary"
                and isinstance(obj, dict)
                and obj.get("type") in ("history", "delta", "live")
        ):
            samples = obj.get("samples") or []
            if not samples:
                return
            frame_type = obj["type"]
            try:
                payload = self._encode_samples_binary(frame_type, samples)
                await ws.send(payload)
            except Exception:
                return
            return

        # Default: JSON text
        try:
            await ws.send(json.dumps(obj, separators=(",", ":")))
        except Exception:
            return

    # ---- heartbeat + live loop ----------------------------------------------

    async def _heartbeat_loop(self, ws: WebSocketServerProtocol):
        while True:
            await asyncio.sleep(self.args.heartbeat_sec)
            await self._send(ws, {"type": "heartbeat", "ts_ms": now_ms()})

    async def _live_loop(self, ws: WebSocketServerProtocol, run: FeedRun, after_seq: int):
        """
        Live sender: streams new samples as they land in the ring.

        Guarantees:
        - Global seq is monotonic and contiguous from the client's perspective unless the ring
          has truncated older samples; in that case we log a global seq gap warning.
        - Each sample carries `series_seq`, which the UI uses to detect per-series gaps/missed.
        """
        last_sent = after_seq
        flush_sleep = max(0.0, LIVE_FLUSH_MS_DEFAULT / 1000.0)

        # Per-client per-series status for logging gaps
        series_state: Dict[str, Dict[str, int]] = {}

        try:
            while True:
                if run.done and last_sent >= (run.final_seq or last_sent):
                    await self._send(ws, {"type": "test_done", "final_seq": run.final_seq})
                    return

                if run.last_seq() <= last_sent:
                    await run.wait_for_new_after(last_sent, timeout=1.0)
                    continue

                end = run.last_seq()
                expected_start = last_sent + 1
                to_send = run.get_range(expected_start, end)

                if to_send:
                    first_seq = int(to_send[0].get("seq", 0))
                    if first_seq > expected_start:
                        skipped = first_seq - expected_start
                        print(
                            f"[live][warn] seq gap detected: expected {expected_start}, "
                            f"got {first_seq} (skipped≈{skipped} samples; ring may have truncated)."
                        )

                idx = 0
                n = len(to_send)
                while idx < n:
                    batch = to_send[idx : idx + self.args.live_batch]
                    if not batch:
                        break

                    # Per-series gap/missed detection using series_seq
                    for s in batch:
                        sid = s.get("series_id")
                        sseq = s.get("series_seq")
                        if not sid or not isinstance(sseq, int):
                            continue
                        st = series_state.get(sid)
                        if st is None:
                            st = {
                                "prev": None,
                                "gaps": 0,
                                "missed": 0,
                                "warned_initial": False,
                            }
                            series_state[sid] = st
                        prev = st["prev"]
                        if prev is None:
                            st["prev"] = sseq
                            if sseq > 1 and not st["warned_initial"]:
                                missed = sseq - 1
                                st["gaps"] += 1
                                st["missed"] += missed
                                print(
                                    f"[live][warn] initial series gap for {sid}: "
                                    f"first series_seq={sseq} (>1, missed≈{missed} earlier samples "
                                    "for this series before this client connected)."
                                )
                                st["warned_initial"] = True
                        else:
                            if sseq > prev + 1:
                                gap = sseq - prev - 1
                                st["gaps"] += 1
                                st["missed"] += gap
                                print(
                                    f"[live][warn] series gap for {sid}: "
                                    f"prev_series_seq={prev}, current={sseq}, gap≈{gap}."
                                )
                            st["prev"] = sseq

                    await self._send(ws, {"type": "live", "samples": batch})
                    last_sent = batch[-1]["seq"]
                    idx += len(batch)
                    await asyncio.sleep(flush_sleep)
        except Exception:
            return


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


async def db_connect(cfg: dict):
    if asyncpg is None:
        raise RuntimeError(
            "asyncpg is required for db_live/db_playback modes. Install with: pip install asyncpg"
        )
    db = cfg["database"]
    return await asyncpg.connect(
        host=db["host"],
        port=db["port"],
        user=db["user"],
        password=db["password"],
        database=db.get("dbname") or db.get("database") or "postgres",
    )


async def db_live_producer(
        run: FeedRun, cfg: dict, tables: dict, poll_interval_ms: int, strategy_id_default: str
):
    """
    Live DB tailer: appends new rows directly into the ring (no precomputed dataset).
    """
    conn = await db_connect(cfg)
    schema = cfg.get("schema", "public")

    def tn(key: str) -> Optional[str]:
        name = tables.get(key)
        if not name:
            return None
        return f'{schema}."{name}"'

    tick_table = tn("tick")
    strat_table = tn("strategy_tick")
    bars_table = tn("bars")
    signals_table = tn("signals")
    orders_table = tn("orders")
    events_table = tn("order_events")
    pnl_table = tn("pnl")

    last_tick_ns = 0
    last_strat_ns = 0
    last_bar_ns = 0
    last_signal_ns = 0
    last_event_ns = 0
    last_pnl_ns = 0

    poll_sleep = poll_interval_ms / 1000.0

    try:
        while True:
            # ticks → <symbol>:ticks
            if tick_table:
                rows = await conn.fetch(
                    f"SELECT tstamp_ns,symbol,price,volume,aggressor "
                    f"FROM {tick_table} WHERE tstamp_ns > $1 "
                    f"ORDER BY tstamp_ns ASC LIMIT 1000",
                    last_tick_ns,
                )
                for r in rows:
                    last_tick_ns = max(last_tick_ns, r["tstamp_ns"])
                    symbol = r["symbol"]
                    t_ms = ns_to_ms(r["tstamp_ns"])
                    run._append(
                        {
                            "series_id": f"{symbol}:ticks",
                            "t_ms": t_ms,
                            "payload": {
                                "price": float(r["price"]),
                                "volume": float(r["volume"]),
                            },
                        }
                    )

            # strategy_tick_log → aggr_cumsum + metrics (generic indicators)
            if strat_table:
                rows = await conn.fetch(
                    f"SELECT tstamp_ns,symbol,strategy_id,cumsum,metrics "
                    f"FROM {strat_table} WHERE tstamp_ns > $1 "
                    f"ORDER BY tstamp_ns ASC LIMIT 1000",
                    last_strat_ns,
                )
                for r in rows:
                    last_strat_ns = max(last_strat_ns, r["tstamp_ns"])
                    symbol = r["symbol"]
                    t_ms = ns_to_ms(r["tstamp_ns"])
                    run._append(
                        {
                            "series_id": f"{symbol}:aggr_cumsum",
                            "t_ms": t_ms,
                            "payload": {"value": float(r["cumsum"])},
                        }
                    )
                    metrics = r.get("metrics") or {}
                    for key, value in metrics.items():
                        run._append(
                            {
                                "series_id": f"{symbol}:{key}",
                                "t_ms": t_ms,
                                "payload": {"value": value},
                            }
                        )

            # time_bars → ohlc_time:<interval>
            if bars_table:
                rows = await conn.fetch(
                    f"SELECT tstamp_ns,symbol,interval_ms,o,h,l,c "
                    f"FROM {bars_table} WHERE tstamp_ns > $1 "
                    f"ORDER BY tstamp_ns ASC LIMIT 1000",
                    last_bar_ns,
                )
                for r in rows:
                    last_bar_ns = max(last_bar_ns, r["tstamp_ns"])
                    symbol = r["symbol"]
                    t_ms = ns_to_ms(r["tstamp_ns"])
                    run._append(
                        {
                            "series_id": f"{symbol}:ohlc_time:{r['interval_ms']}",
                            "t_ms": t_ms,
                            "payload": {
                                "o": float(r["o"]),
                                "h": float(r["h"]),
                                "l": float(r["l"]),
                                "c": float(r["c"]),
                            },
                        }
                    )

            # strategy_signals → strategy:<id>:signals
            if signals_table:
                rows = await conn.fetch(
                    f"SELECT tstamp_ns,symbol,strategy_id,side,desired_qty,desired_price,reason "
                    f"FROM {signals_table} WHERE tstamp_ns > $1 "
                    f"ORDER BY tstamp_ns ASC LIMIT 1000",
                    last_signal_ns,
                )
                for r in rows:
                    last_signal_ns = max(last_signal_ns, r["tstamp_ns"])
                    symbol = r["symbol"]
                    t_ms = ns_to_ms(r["tstamp_ns"])
                    side = "long" if r["side"] == "B" else "short"
                    run._append(
                        {
                            "series_id": f"{symbol}:strategy:{r['strategy_id']}:signals",
                            "t_ms": t_ms,
                            "payload": {
                                "strategy": r["strategy_id"],
                                "side": side,
                                "desired_qty": int(r["desired_qty"]),
                                "price": float(r["desired_price"]),
                                "reason": r["reason"],
                            },
                        }
                    )

            # orders + order_events(FILL) → markers
            if events_table and orders_table:
                rows = await conn.fetch(
                    f"SELECT e.event_ts, o.symbol, o.side, o.leg_type, e.qty, e.price "
                    f"FROM {events_table} e "
                    f"JOIN {orders_table} o ON e.client_tag = o.client_tag "
                    f"WHERE e.event_type = 'FILL' AND e.event_ts > $1 "
                    f"ORDER BY e.event_ts ASC LIMIT 1000",
                    last_event_ns,
                )
                for r in rows:
                    last_event_ns = max(last_event_ns, r["event_ts"])
                    symbol = r["symbol"]
                    t_ms = ns_to_ms(r["event_ts"])
                    side = "long" if r["side"] == "B" else "short"
                    tag = "entry" if r["leg_type"] == "ENTRY" else "exit"
                    run._append(
                        {
                            "series_id": f"{symbol}:strategy:{strategy_id_default}:markers",
                            "t_ms": t_ms,
                            "payload": {
                                "strategy": strategy_id_default,
                                "side": side,
                                "tag": tag,
                                "price": float(r["price"]),
                                "qty": int(r["qty"] or 0),
                            },
                        }
                    )

            # strategy_pnl → pnl series
            if pnl_table:
                rows = await conn.fetch(
                    f"SELECT tstamp_ns,symbol,strategy_id,cum_realized_pnl "
                    f"FROM {pnl_table} WHERE tstamp_ns > $1 "
                    f"ORDER BY tstamp_ns ASC LIMIT 1000",
                    last_pnl_ns,
                )
                for r in rows:
                    last_pnl_ns = max(last_pnl_ns, r["tstamp_ns"])
                    symbol = r["symbol"]
                    t_ms = ns_to_ms(r["tstamp_ns"])
                    run._append(
                        {
                            "series_id": f"{symbol}:strategy:{r['strategy_id']}:pnl",
                            "t_ms": t_ms,
                            "payload": {"value": float(r["cum_realized_pnl"])},
                        }
                    )

            await asyncio.sleep(poll_sleep)
    finally:
        await conn.close()


async def build_db_playback_samples(
        cfg: dict,
        tables: dict,
        from_iso: str,
        to_iso: str,
        strategy_id_default: str,
) -> List[dict]:
    """
    Load rows from DB in [from_iso, to_iso], convert them into a flat list of samples.
    """
    conn = await db_connect(cfg)
    schema = cfg.get("schema", "public")

    def tn(key: str) -> Optional[str]:
        name = tables.get(key)
        if not name:
            return None
        return f'{schema}."{name}"'

    tick_table = tn("tick")
    strat_table = tn("strategy_tick")
    bars_table = tn("bars")
    signals_table = tn("signals")
    orders_table = tn("orders")
    events_table = tn("order_events")
    pnl_table = tn("pnl")

    from_ns = parse_iso_to_ns(from_iso)
    to_ns = parse_iso_to_ns(to_iso)

    events: List[Tuple[int, str, dict]] = []

    def add_event(ts_ns: int, kind: str, row: dict):
        if from_ns <= ts_ns <= to_ns:
            events.append((ts_ns, kind, row))

    # gather from each table
    if tick_table:
        rows = await conn.fetch(
            f"SELECT tstamp_ns,symbol,price,volume,aggressor "
            f"FROM {tick_table} WHERE tstamp_ns BETWEEN $1 AND $2 "
            f"ORDER BY tstamp_ns ASC",
            from_ns,
            to_ns,
        )
        for r in rows:
            add_event(r["tstamp_ns"], "tick", dict(r))

    if strat_table:
        rows = await conn.fetch(
            f"SELECT tstamp_ns,symbol,strategy_id,cumsum,metrics "
            f"FROM {strat_table} WHERE tstamp_ns BETWEEN $1 AND $2 "
            f"ORDER BY tstamp_ns ASC",
            from_ns,
            to_ns,
        )
        for r in rows:
            add_event(r["tstamp_ns"], "strat", dict(r))

    if bars_table:
        rows = await conn.fetch(
            f"SELECT tstamp_ns,symbol,interval_ms,o,h,l,c "
            f"FROM {bars_table} WHERE tstamp_ns BETWEEN $1 AND $2 "
            f"ORDER BY tstamp_ns ASC",
            from_ns,
            to_ns,
        )
        for r in rows:
            add_event(r["tstamp_ns"], "bar", dict(r))

    if signals_table:
        rows = await conn.fetch(
            f"SELECT tstamp_ns,symbol,strategy_id,side,desired_qty,desired_price,reason "
            f"FROM {signals_table} WHERE tstamp_ns BETWEEN $1 AND $2 "
            f"ORDER BY tstamp_ns ASC",
            from_ns,
            to_ns,
        )
        for r in rows:
            add_event(r["tstamp_ns"], "signal", dict(r))

    if events_table and orders_table:
        rows = await conn.fetch(
            f"SELECT e.event_ts, o.symbol, o.side, o.leg_type, e.qty, e.price "
            f"FROM {events_table} e "
            f"JOIN {orders_table} o ON e.client_tag = o.client_tag "
            f"WHERE e.event_type = 'FILL' AND e.event_ts BETWEEN $1 AND $2 "
            f"ORDER BY e.event_ts ASC",
            from_ns,
            to_ns,
        )
        for r in rows:
            add_event(r["event_ts"], "fill", dict(r))

    if pnl_table:
        rows = await conn.fetch(
            f"SELECT tstamp_ns,symbol,strategy_id,cum_realized_pnl "
            f"FROM {pnl_table} WHERE tstamp_ns BETWEEN $1 AND $2 "
            f"ORDER BY tstamp_ns ASC",
            from_ns,
            to_ns,
        )
        for r in rows:
            add_event(r["tstamp_ns"], "pnl", dict(r))

    await conn.close()

    events.sort(key=lambda e: e[0])
    if not events:
        print("[db_playback] window has no events")
        return []

    samples: List[dict] = []
    for ts_ns, kind, r in events:
        t_ms = ns_to_ms(ts_ns)
        symbol = r.get("symbol", "")
        if kind == "tick":
            samples.append(
                {
                    "series_id": f"{symbol}:ticks",
                    "t_ms": t_ms,
                    "payload": {
                        "price": float(r["price"]),
                        "volume": float(r["volume"]),
                    },
                }
            )
        elif kind == "strat":
            samples.append(
                {
                    "series_id": f"{symbol}:aggr_cumsum",
                    "t_ms": t_ms,
                    "payload": {"value": float(r["cumsum"])},
                }
            )
            metrics = r.get("metrics") or {}
            for key, value in metrics.items():
                samples.append(
                    {
                        "series_id": f"{symbol}:{key}",
                        "t_ms": t_ms,
                        "payload": {"value": value},
                    }
                )
        elif kind == "bar":
            samples.append(
                {
                    "series_id": f"{symbol}:ohlc_time:{r['interval_ms']}",
                    "t_ms": t_ms,
                    "payload": {
                        "o": float(r["o"]),
                        "h": float(r["h"]),
                        "l": float(r["l"]),
                        "c": float(r["c"]),
                    },
                }
            )
        elif kind == "signal":
            side = "long" if r["side"] == "B" else "short"
            samples.append(
                {
                    "series_id": f"{symbol}:strategy:{r['strategy_id']}:signals",
                    "t_ms": t_ms,
                    "payload": {
                        "strategy": r["strategy_id"],
                        "side": side,
                        "desired_qty": int(r["desired_qty"]),
                        "price": float(r["desired_price"]),
                        "reason": r["reason"],
                    },
                }
            )
        elif kind == "fill":
            side = "long" if r["side"] == "B" else "short"
            tag = "entry" if r["leg_type"] == "ENTRY" else "exit"
            samples.append(
                {
                    "series_id": f"{symbol}:strategy:{strategy_id_default}:markers",
                    "t_ms": t_ms,
                    "payload": {
                        "strategy": strategy_id_default,
                        "side": side,
                        "tag": tag,
                        "price": float(r["price"]),
                        "qty": int(r["qty"] or 0),
                    },
                }
            )
        elif kind == "pnl":
            samples.append(
                {
                    "series_id": f"{symbol}:strategy:{r['strategy_id']}:pnl",
                    "t_ms": t_ms,
                    "payload": {"value": float(r["cum_realized_pnl"])},
                }
            )

    print(
        f"[db_playback] window events={len(events)} → samples={len(samples)} "
        f"(from={from_iso}, to={to_iso})"
    )
    return samples


# ---------------------------------------------------------------------------
# CLI / config
# ---------------------------------------------------------------------------


def parse_args():
    p = argparse.ArgumentParser(
        description="WebSocket feed server (synthetic + DB live/playback)"
    )
    p.add_argument("--host", default=DEFAULT_HOST)
    p.add_argument("--port", type=int, default=DEFAULT_PORT)

    # protocol / transport
    p.add_argument(
        "--ring-capacity",
        type=int,
        default=RING_CAPACITY_DEFAULT,
        dest="ring_capacity",
    )
    p.add_argument(
        "--history-chunk",
        type=int,
        default=HISTORY_CHUNK_DEFAULT,
        dest="history_chunk",
    )
    p.add_argument(
        "--live-batch", type=int, default=LIVE_BATCH_DEFAULT, dest="live_batch"
    )
    p.add_argument(
        "--heartbeat-sec",
        type=int,
        default=HEARTBEAT_SEC_DEFAULT,
        dest="heartbeat_sec",
    )
    p.add_argument(
        "--ws-format",
        choices=["text", "binary"],
        default="text",
        dest="ws_format",
        help="Server-to-client wire format: 'text' (JSON) or 'binary' (compact binary samples)",
    )
    p.add_argument(
        "--emit-samples-per-sec",
        type=float,
        default=0.0,
        dest="emit_samples_per_sec",
        help="Target samples/sec for synthetic/db_playback producers (0 = as fast as possible)",
    )

    # mode + synthetic basics
    p.add_argument(
        "--mode",
        choices=["quick", "session", "db_live", "db_playback"],
        default="quick",
    )
    p.add_argument(
        "--instrument", 
        type=str, 
        default="ES.c.0", 
        dest="instrument",
        help="Comma-separated list of instruments (e.g., 'ESU5,MESU5' or 'ES.c.0')"
    )

    p.add_argument(
        "--total-samples",
        type=int,
        default=TOTAL_SAMPLES_DEFAULT,
        dest="total_samples",
    )

    p.add_argument(
        "--session-ms",
        type=int,
        default=SESSION_MS_DEFAULT,
        dest="session_ms",
        help="Logical session length (ms) for session mode",
    )
    p.add_argument(
        "--tick-dt-ms",
        type=int,
        default=None,
        dest="tick_dt_ms",
        help="Logical ms between synthetic ticks on t_ms axis",
    )
    p.add_argument(
        "--tick-hz",
        type=float,
        default=None,
        dest="tick_hz",
        help="Ticks per second (alternative to --tick-dt-ms). Converts to tick_dt_ms = 1000 / tick_hz",
    )
    p.add_argument("--seed", type=int, default=None, dest="seed")

    # price model
    p.add_argument(
        "--price-model",
        choices=["sine", "randomwalk"],
        default=PRICE_MODEL_DEFAULT,
        dest="price_model",
    )
    p.add_argument(
        "--base-price", type=float, default=BASE_PRICE_DEFAULT, dest="base_price"
    )
    p.add_argument(
        "--sine-period-sec",
        type=float,
        default=SINE_PERIOD_SEC_DEFAULT,
        dest="sine_period_sec",
    )
    p.add_argument(
        "--sine-amp", type=float, default=SINE_AMP_DEFAULT, dest="sine_amp"
    )
    p.add_argument(
        "--sine-noise", type=float, default=SINE_NOISE_DEFAULT, dest="sine_noise"
    )
    p.add_argument(
        "--rw-drift", type=float, default=RW_DRIFT_DEFAULT, dest="rw_drift"
    )
    p.add_argument("--rw-vol", type=float, default=RW_VOL_DEFAULT, dest="rw_vol")

    # bars / indicators / strategy
    p.add_argument(
        "--bar-intervals",
        type=str,
        default=BAR_INTERVALS_DEFAULT,
        dest="bar_intervals_str",
    )
    p.add_argument(
        "--indicator-windows",
        type=str,
        default=None,
        dest="indicator_windows",
        help='Comma-separated SMA windows for synthetic mode, e.g. "10,20,50"',
    )
    p.add_argument(
        "--sma-window",
        type=int,
        default=10,
        dest="sma_window",
        help="Fallback single SMA window when --indicator-windows is omitted",
    )

    p.add_argument(
        "--strategy-rate-per-min",
        type=float,
        default=STRAT_RATE_PER_MIN_DEF,
        dest="strategy_rate_per_min",
    )
    p.add_argument(
        "--strategy-hold-bars",
        type=int,
        default=STRAT_HOLD_BARS_DEF,
        dest="strategy_hold_bars",
    )
    p.add_argument(
        "--strategy-max-open",
        type=int,
        default=STRAT_MAX_OPEN_DEF,
        dest="strategy_max_open",
    )
    p.add_argument(
        "--strategy-id", type=str, default="alpha", dest="strategy_id"
    )

    # DB config
    p.add_argument(
        "--config", type=str, default=None, help="DB config JSON for db_* modes"
    )
    p.add_argument(
        "--playback-from",
        type=str,
        default=None,
        help="ISO datetime playback start",
    )
    p.add_argument(
        "--playback-to", type=str, default=None, help="ISO datetime playback end"
    )
    p.add_argument(
        "--playback-tick-hz",
        type=float,
        default=None,
        help="(Deprecated) legacy playback pacing; prefer --emit-samples-per-sec",
    )

    a = p.parse_args()

    # Handle tick-hz / tick-dt-ms conversion
    if a.tick_hz is not None and a.tick_dt_ms is not None:
        raise SystemExit("Cannot specify both --tick-hz and --tick-dt-ms")
    if a.tick_hz is not None:
        if a.tick_hz <= 0:
            raise SystemExit("--tick-hz must be > 0")
        a.tick_dt_ms = int(1000.0 / a.tick_hz)
    elif a.tick_dt_ms is None:
        a.tick_dt_ms = TICK_DT_MS_DEFAULT

    # parse instruments (comma-separated)
    try:
        a.instruments = [
            x.strip() for x in a.instrument.split(",") if x.strip()
        ]
        if not a.instruments:
            a.instruments = ["ES.c.0"]
    except Exception:
        a.instruments = [a.instrument] if a.instrument else ["ES.c.0"]

    # parse bar intervals
    try:
        a.bar_intervals = [
            int(x.strip()) for x in a.bar_intervals_str.split(",") if x.strip()
        ]
        if not a.bar_intervals:
            a.bar_intervals = [10_000]
    except Exception:
        a.bar_intervals = [10_000]

    # indicator windows
    if a.indicator_windows:
        try:
            a.indicator_windows_list = [
                int(x.strip()) for x in a.indicator_windows.split(",") if x.strip()
            ]
        except Exception:
            a.indicator_windows_list = [a.sma_window]
    else:
        a.indicator_windows_list = [a.sma_window]

    return a


def validate_and_log_config(args, cfg: Optional[dict]):
    """Lightweight sanity checks / throughput estimates printed at startup."""
    if args.ring_capacity <= 0:
        raise SystemExit("--ring-capacity must be > 0")
    if args.history_chunk <= 0:
        raise SystemExit("--history-chunk must be > 0")
    if args.live_batch <= 0:
        raise SystemExit("--live-batch must be > 0")

    sender_capacity = args.live_batch / (LIVE_FLUSH_MS_DEFAULT / 1000.0)
    print(
        f"[config] WS sender capacity ≈ {sender_capacity:.0f} samples/s "
        f"(live_batch={args.live_batch}, flush_ms={LIVE_FLUSH_MS_DEFAULT})"
    )
    print(f"[config] WS wire format = {getattr(args, 'ws_format', 'text')}")

    if args.emit_samples_per_sec > 0:
        print(
            f"[config] target emit rate ≈ {args.emit_samples_per_sec:.0f} samples/s "
            f"(producers → ring)"
        )
        if args.emit_samples_per_sec > sender_capacity * 0.9:
            print(
                "[config][warn] emit-samples-per-sec is close to or above sender capacity; "
                "clients may see gaps if they can't keep up."
            )
    else:
        print("[config] emit-samples-per-sec = 0 → unpaced producers (as fast as possible)")

    # Synthetic: estimate logical tick rate & dataset scale
    if args.mode in ("quick", "session"):
        tick_rate = 1000.0 / max(1, args.tick_dt_ms)
        n_ind = len(getattr(args, "indicator_windows_list", []) or [1])
        fanout = 1.0 + float(n_ind)
        session_sec = args.session_ms / 1000.0
        est_samples = tick_rate * fanout * session_sec if args.mode == "session" else float(
            args.total_samples or TOTAL_SAMPLES_DEFAULT
        )
        print(
            f"[config] synthetic tick_dt_ms={args.tick_dt_ms} → tick_rate≈{tick_rate:.1f} t/s, "
            f"est_samples≈{est_samples:.0f}"
        )
        if est_samples > args.ring_capacity:
            print(
                f"[config][warn] est_samples≈{est_samples:.0f} > ring_capacity={args.ring_capacity}; "
                "ring will truncate oldest samples by the end of the run. Increase --ring-capacity "
                "if you want to retain a full synthetic day for reconnects."
            )

    # db_live: rough ingest bound
    if args.mode == "db_live" and cfg:
        poll_ms = cfg.get("live_poll_interval_ms", 50)
        if poll_ms <= 0:
            print("[config][warn] live_poll_interval_ms<=0; using 50ms for estimates.")
            poll_ms = 50
        polls_per_sec = 1000.0 / poll_ms
        rows_per_sec_per_table_max = polls_per_sec * 1000.0  # LIMIT 1000
        tables_cfg = cfg.get("tables", {})
        enabled_tables = [k for k, v in tables_cfg.items() if v]
        n_tables = max(1, len(enabled_tables))
        max_metrics_per_row = cfg.get("max_metrics_per_row", 10)
        fanout_max = 1.0 + max_metrics_per_row
        ingest_rate_theoretical = rows_per_sec_per_table_max * fanout_max * n_tables
        print(
            f"[config] db_live theoretical upper bound ≈ {ingest_rate_theoretical:.0f} samples/s "
            f"(poll_ms={poll_ms}, tables={n_tables}, max_metrics_per_row≈{max_metrics_per_row})"
        )
        if ingest_rate_theoretical > sender_capacity * 2.0:
            print(
                "[config][warn] db_live theoretical max rate is much higher than sender capacity; "
                "if DB is very busy, ring may overflow. Consider increasing --live-batch, "
                "increasing --ring-capacity, or increasing live_poll_interval_ms."
            )

    # db_playback: warn if only playback_tick_hz is provided
    if args.mode == "db_playback":
        if args.emit_samples_per_sec <= 0 and args.playback_tick_hz:
            print(
                "[config][warn] --playback-tick-hz is deprecated; prefer --emit-samples-per-sec. "
                "Playback will approximate samples/sec ~= playback-tick-hz."
            )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def main():
    args = parse_args()

    cfg = None
    tables = None

    if args.mode in ("db_live", "db_playback"):
        if not args.config:
            raise SystemExit("--config is required for db_live/db_playback modes")
        with open(args.config, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        tables = cfg["tables"]

        if args.mode == "db_playback":
            if not args.playback_from or not args.playback_to:
                raise SystemExit(
                    "--playback-from and --playback-to are required for db_playback"
                )

    validate_and_log_config(args, cfg)

    server = WSServer(args, cfg)

    # Create FeedRun and start appropriate producers
    run = FeedRun(ring_capacity=args.ring_capacity, live_batch=args.live_batch)
    async with server._run_lock:
        server.run = run

    if args.mode in ("quick", "session"):
        # Synthetic: build full dataset, then start playback
        synthetic_samples = build_synthetic_dataset(args)
        if len(synthetic_samples) > args.ring_capacity:
            print(
                f"[build][warn] synthetic samples={len(synthetic_samples)} > ring_capacity="
                f"{args.ring_capacity}; oldest samples will be truncated in the ring."
            )
        await asyncio.sleep(0)  # let logs flush
        asyncio.create_task(
            playback_from_memory(
                run,
                synthetic_samples,
                emit_sps=args.emit_samples_per_sec,
                label=f"synthetic-{args.mode}",
            )
        )

    elif args.mode == "db_live":
        # DB live: start live tailer
        strategy_id_default = cfg.get("strategy_id", args.strategy_id)
        poll_ms = cfg.get("live_poll_interval_ms", 50)
        asyncio.create_task(
            db_live_producer(run, cfg, tables, poll_ms, strategy_id_default)
        )

    elif args.mode == "db_playback":
        # DB playback: build full sample list, then start playback
        strategy_id_default = cfg.get("strategy_id", args.strategy_id)
        playback_samples = await build_db_playback_samples(
            cfg,
            tables,
            args.playback_from,
            args.playback_to,
            strategy_id_default,
        )
        if len(playback_samples) > args.ring_capacity:
            print(
                f"[build][warn] db_playback samples={len(playback_samples)} > ring_capacity="
                f"{args.ring_capacity}; oldest samples will be truncated in the ring."
            )
        emit_sps = args.emit_samples_per_sec
        if emit_sps <= 0 and args.playback_tick_hz:
            emit_sps = float(args.playback_tick_hz)
        asyncio.create_task(
            playback_from_memory(
                run,
                playback_samples,
                emit_sps=emit_sps,
                label="db_playback",
            )
        )

    async def ws_handler(ws):
        await server.handler(ws)

    async with websockets.serve(ws_handler, args.host, args.port, compression=None):
        print(f"[server] listening on ws://{args.host}:{args.port}")
        print(f"[server] mode={args.mode} instruments={args.instruments}")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
