#!/usr/bin/env python3
"""Clear the "executable stack" flag (PT_GNU_STACK RWE) from Maple 18 libraries.

Why. Maple 18 (2014) was built with an old toolchain, and some of its external libraries
(`libatlas.so`, `libmsp.so`) are marked as requiring an executable stack. Starting
with glibc 2.41 (Ubuntu 25.04+/26.04) `dlopen` rejects such objects:

    Error, (in dsolve) external library libmodLA.so could not be found/used
    dlopen: libatlas.so: cannot enable executable stack as shared object
            requires: Invalid argument

Because of this, in Maple 18 everything that pulls in `libmodLA`/ATLAS silently breaks —
`dsolve`, `pdsolve`, some numerical and linear-algebra algorithms.

What it does. Clears the PF_X bit in the PT_GNU_STACK program header. This is not
a weakening of Maple's own protection: the libraries simply stop *requiring*
an executable stack, and they do not need one anyway (a build artifact).

Usage:

    python3 fix-execstack.py                 # show what would be fixed
    python3 fix-execstack.py --apply         # fix (with *.bak-execstack backups)
    python3 fix-execstack.py --apply --root /opt/maple18
    python3 fix-execstack.py --restore --root /opt/maple18   # restore backups
"""
from __future__ import annotations

import argparse
import shutil
import struct
import sys
from pathlib import Path

PT_GNU_STACK = 0x6474E551
PF_X = 0x1
BAK_SUFFIX = ".bak-execstack"


def gnu_stack_offset(data: bytes) -> int | None:
    """Offset of the p_flags field of the PT_GNU_STACK program header."""
    if data[:4] != b"\x7fELF":
        return None
    if data[4] != 2:  # 64-bit only
        return None
    e_phoff = struct.unpack_from("<Q", data, 0x20)[0]
    e_phentsize = struct.unpack_from("<H", data, 0x36)[0]
    e_phnum = struct.unpack_from("<H", data, 0x38)[0]
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        if struct.unpack_from("<I", data, off)[0] == PT_GNU_STACK:
            return off + 4
    return None


def needs_fix(path: Path) -> bool:
    data = path.read_bytes()
    off = gnu_stack_offset(data)
    return off is not None and bool(struct.unpack_from("<I", data, off)[0] & PF_X)


def fix(path: Path, apply: bool) -> str:
    data = bytearray(path.read_bytes())
    off = gnu_stack_offset(data)
    if off is None:
        return "пропуск (не ELF64)"
    flags = struct.unpack_from("<I", data, off)[0]
    if not flags & PF_X:
        return "уже ок"
    if not apply:
        return "нужно исправить"
    bak = path.with_name(path.name + BAK_SUFFIX)
    if not bak.exists():
        shutil.copy2(path, bak)
    struct.pack_into("<I", data, off, flags & ~PF_X)
    path.write_bytes(data)
    return "исправлено"


def restore(root: Path) -> int:
    n = 0
    for bak in sorted(root.rglob("*" + BAK_SUFFIX)):
        target = bak.with_name(bak.name[: -len(BAK_SUFFIX)])
        shutil.copy2(bak, target)
        print(f"восстановлено: {target}")
        n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default="/opt/maple18", help="каталог установки Maple (по умолчанию /opt/maple18)")
    ap.add_argument("--apply", action="store_true", help="применить изменения (иначе только показать)")
    ap.add_argument("--restore", action="store_true", help="вернуть файлы из *.bak-execstack")
    args = ap.parse_args()

    root = Path(args.root)
    if not root.is_dir():
        print(f"нет каталога {root}", file=sys.stderr)
        return 2

    if args.restore:
        return 0 if restore(root) else 1

    # Only libraries in bin.* are of interest — those are the ones loaded via dlopen.
    candidates = [p for p in sorted(root.glob("bin.*/**/*.so*")) if p.is_file() and not p.name.endswith(BAK_SUFFIX)]
    broken = [p for p in candidates if needs_fix(p)]
    if not broken:
        print("нечего исправлять: библиотек с исполняемым стеком не найдено")
        return 0
    for p in broken:
        print(f"{fix(p, args.apply):16} {p}")
    if not args.apply:
        print("\nэто был предпросмотр; повторите с --apply (бэкапы *.bak-execstack сохраняются)")
    else:
        print("\nготово. Проверка: maple -q -s -e2 <<< 'dsolve(diff(y(x),x)=y(x), y(x));'")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
