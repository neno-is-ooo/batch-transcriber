"""CLI entry point for whisper-batch."""

from __future__ import annotations

import argparse
from collections.abc import Sequence

from .model_manager import print_capabilities
from .worker import process_manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="whisper-batch")
    parser.add_argument("--manifest")
    parser.add_argument("--output-dir", dest="output_dir")
    parser.add_argument("--model", default="base")
    parser.add_argument("--capabilities", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.capabilities:
        print_capabilities()
        return 0

    if not args.manifest or not args.output_dir:
        parser.error("--manifest and --output-dir are required unless --capabilities is set")

    process_manifest(args.manifest, args.output_dir, args.model)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
