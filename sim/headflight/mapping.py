"""Head angle to view angle."""

import math

from .config import Axis


def lookup(table: list, x: float) -> float:
    """Odd-symmetric piecewise-linear lookup. Inputs past the last point clamp to it."""
    m = abs(x)
    y = table[-1][1]
    for (x0, y0), (x1, y1) in zip(table, table[1:]):
        if m <= x1:
            y = y0 + (y1 - y0) * (m - x0) / (x1 - x0)
            break
    return math.copysign(y, x)


def head_to_view(axis: Axis, head_deg: float) -> float:
    """The deadzone subtracts rather than clips, so the view never jumps when leaving it."""
    signed = -head_deg if axis.invert else head_deg
    settled = math.copysign(max(0.0, abs(signed) - axis.deadzone), signed)
    return lookup(axis.curve, settled * axis.sensitivity)
