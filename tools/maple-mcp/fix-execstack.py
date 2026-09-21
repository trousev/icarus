#!/usr/bin/env python3
"""Снять флаг «исполняемый стек» (PT_GNU_STACK RWE) с библиотек Maple 18.

Зачем. Maple 18 (2014) собрана старым тулчейном, и часть её внешних библиотек
(`libatlas.so`, `libmsp.so`) помечена как требующая исполняемого стека. Начиная
с glibc 2.41 (Ubuntu 25.04+/26.04) `dlopen` такие объекты отвергает:

    Error, (in dsolve) external library libmodLA.so could not be found/used
    dlopen: libatlas.so: cannot enable executable stack as shared object
            requires: Invalid argument

Из-за этого в Maple 18 молча ломается всё, что тянет `libmodLA`/ATLAS —
`dsolve`, `pdsolve`, часть численных и линейно-алгебраических алгоритмов.

Что делает. Обнуляет бит PF_X в программном заголовке PT_GNU_STACK. Это не
ослабление защиты самого Maple: библиотеки просто перестают *требовать*
исполняемый стек, а он им и не нужен (артефакт сборки).

Использование:

    python3 fix-execstack.py                 # показать, что будет исправлено
    python3 fix-execstack.py --apply         # исправить (с бэкапами *.bak-execstack)
    python3 fix-execstack.py --apply --root /opt/maple18
    python3 fix-execstack.py --restore --root /opt/maple18   # вернуть бэкапы
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
    """Смещение поля p_flags программного заголовка PT_GNU_STACK."""
    if data[:4] != b"\x7fELF":
        return None
    if data[4] != 2:  # только 64-битные
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

    # Интересуют только библиотеки в bin.* — это они грузятся через dlopen.
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
