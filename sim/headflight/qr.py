"""A small QR encoder, so a phone can open the stick page by scanning instead of typing.

Covers byte mode at error level L for versions 1-5, which holds up to 106 bytes. That is plenty
for a LAN URL, and those versions all use one error-correction block, which keeps this short.
"""

QUIET_ZONE = 4

# version: (total codewords, error-correction codewords)
VERSIONS = {1: (26, 7), 2: (44, 10), 3: (70, 15), 4: (100, 20), 5: (134, 26)}

MASKS = [
    lambda x, y: (x + y) % 2 == 0,
    lambda x, y: y % 2 == 0,
    lambda x, y: x % 3 == 0,
    lambda x, y: (x + y) % 3 == 0,
    lambda x, y: (x // 3 + y // 2) % 2 == 0,
    lambda x, y: x * y % 2 + x * y % 3 == 0,
    lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0,
    lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0,
]


def gf_multiply(a: int, b: int) -> int:
    """Multiply in GF(256) with the QR polynomial 0x11D."""
    result = 0
    while b:
        if b & 1:
            result ^= a
        a <<= 1
        if a & 0x100:
            a ^= 0x11D
        b >>= 1
    return result


def error_correction(data: list[int], count: int) -> list[int]:
    """Reed-Solomon remainder of `data` over a generator with roots 2^0 .. 2^(count-1)."""
    generator = [1]
    root = 1
    for _ in range(count):
        generator = [
            (generator[i] if i < len(generator) else 0) ^ (gf_multiply(generator[i - 1], root) if i else 0)
            for i in range(len(generator) + 1)
        ]
        root = gf_multiply(root, 2)

    remainder = [0] * count
    for byte in data:
        factor = byte ^ remainder[0]
        remainder = remainder[1:] + [0]
        for i in range(count):
            remainder[i] ^= gf_multiply(generator[i + 1], factor)
    return remainder


def _codewords(data: bytes, version: int) -> list[int]:
    total, ec_count = VERSIONS[version]
    capacity = total - ec_count
    bits = "0100" + f"{len(data):08b}" + "".join(f"{b:08b}" for b in data)
    bits += "0" * min(4, capacity * 8 - len(bits))
    bits += "0" * (-len(bits) % 8)
    words = [int(bits[i:i + 8], 2) for i in range(0, len(bits), 8)]
    pad = [0xEC, 0x11]
    words += [pad[i % 2] for i in range(capacity - len(words))]
    return words + error_correction(words, ec_count)


def _function_patterns(size: int, version: int) -> tuple[list[list[bool]], list[list[bool]]]:
    """Fixed patterns, and which modules are off limits to data."""
    dark = [[False] * size for _ in range(size)]
    fixed = [[False] * size for _ in range(size)]

    def put(x: int, y: int, value: bool) -> None:
        if 0 <= x < size and 0 <= y < size:
            dark[y][x] = value
            fixed[y][x] = True

    for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                distance = max(abs(dx), abs(dy))
                put(cx + dx, cy + dy, distance != 2 and distance != 4)

    if version >= 2:
        center = size - 7
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                put(center + dx, center + dy, max(abs(dx), abs(dy)) != 1)

    for i in range(size):
        if not fixed[6][i]:
            put(i, 6, i % 2 == 0)
        if not fixed[i][6]:
            put(6, i, i % 2 == 0)

    # Reserve the format bits, which depend on the mask and are written last.
    for i in range(9):
        if i != 6:      # that spot belongs to the timing line
            put(8, i, False)
            put(i, 8, False)
    for i in range(8):
        put(size - 1 - i, 8, False)
        put(8, size - 1 - i, False)
    put(8, size - 8, True)
    return dark, fixed


def _place_data(modules: list[list[bool]], fixed: list[list[bool]], words: list[int]) -> None:
    size = len(modules)
    bits = [bool(word >> shift & 1) for word in words for shift in range(7, -1, -1)]
    index = 0
    right = size - 1
    while right >= 1:
        if right == 6:
            right = 5       # the vertical timing line takes a whole column
        upward = (right + 1) & 2 == 0
        for step in range(size):
            y = size - 1 - step if upward else step
            for x in (right, right - 1):
                if not fixed[y][x] and index < len(bits):
                    modules[y][x] = bits[index]
                    index += 1
        right -= 2


def _write_format(modules: list[list[bool]], mask: int) -> None:
    size = len(modules)
    data = 0b01 << 3 | mask     # 01 is error level L
    remainder = data
    for _ in range(10):
        remainder = remainder << 1 ^ (remainder >> 9) * 0x537
    bits = (data << 10 | remainder) ^ 0x5412
    bit = [bool(bits >> i & 1) for i in range(15)]

    for i in range(6):
        modules[i][8] = bit[i]
    modules[7][8] = bit[6]
    modules[8][8] = bit[7]
    modules[8][7] = bit[8]
    for i in range(9, 15):
        modules[8][14 - i] = bit[i]
    for i in range(8):
        modules[8][size - 1 - i] = bit[i]
    for i in range(8, 15):
        modules[size - 15 + i][8] = bit[i]


def _penalty(modules: list[list[bool]]) -> int:
    """How hard a pattern is to read: long runs, solid blocks, and imbalance."""
    size = len(modules)
    score = 0
    for line in [*modules, *zip(*modules)]:
        run = 1
        for a, b in zip(line, line[1:]):
            run = run + 1 if a == b else 1
            if run == 5:
                score += 3
            elif run > 5:
                score += 1
    for y in range(size - 1):
        for x in range(size - 1):
            if modules[y][x] == modules[y][x + 1] == modules[y + 1][x] == modules[y + 1][x + 1]:
                score += 3
    dark = sum(map(sum, modules))
    return score + abs(dark * 20 // (size * size) - 10) * 10


def encode(text: str) -> list[list[bool]]:
    """QR modules for `text`, True for dark, without the quiet zone."""
    data = text.encode("utf-8")
    fits = [v for v, (total, ec) in VERSIONS.items() if len(data) <= total - ec - 2]
    if not fits:
        raise ValueError(f"too long for a QR code here: {len(data)} bytes")
    version = fits[0]
    size = 17 + 4 * version
    base, fixed = _function_patterns(size, version)
    _place_data(base, fixed, _codewords(data, version))

    best, best_score = None, None
    for mask, rule in enumerate(MASKS):
        candidate = [
            [base[y][x] ^ (not fixed[y][x] and rule(x, y)) for x in range(size)]
            for y in range(size)
        ]
        _write_format(candidate, mask)
        score = _penalty(candidate)
        if best_score is None or score < best_score:
            best, best_score = candidate, score
    return best


def svg(text: str) -> str:
    modules = encode(text)
    side = len(modules) + QUIET_ZONE * 2
    squares = "".join(
        f"M{x + QUIET_ZONE} {y + QUIET_ZONE}h1v1h-1z"
        for y, row in enumerate(modules) for x, dark in enumerate(row) if dark
    )
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side} {side}" shape-rendering="crispEdges">'
            f'<rect width="{side}" height="{side}" fill="#fff"/><path d="{squares}" fill="#000"/></svg>')


def terminal(text: str) -> str:
    """Two rows per character cell, black on white whatever the terminal's theme."""
    modules = encode(text)
    side = len(modules) + 4
    blank = [False] * side
    rows = [blank, blank, *([False, False, *row, False, False] for row in modules), blank, blank]
    if len(rows) % 2:
        rows.append(blank)
    blocks = {(False, False): " ", (True, False): "▀", (False, True): "▄", (True, True): "█"}
    lines = [
        "".join(blocks[pair] for pair in zip(rows[y], rows[y + 1]))
        for y in range(0, len(rows), 2)
    ]
    return "\n".join(f"\x1b[30;47m{line}\x1b[0m" for line in lines)
