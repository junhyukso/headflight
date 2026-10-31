"""Command line: python3 -m headflight [run|record|replay]"""

import argparse

from .protocol import DEFAULT_PORT


def main() -> None:
    parser = argparse.ArgumentParser(prog="headflight", description="AirPods head-tracked fighter cockpit")
    commands = parser.add_subparsers(dest="command")

    run = commands.add_parser("run", help="run the simulator server (the default)")
    run.add_argument("--config", default="headflight.toml")
    run.add_argument("--no-phone", action="store_true", help="do not serve the phone stick page")

    record = commands.add_parser("record", help="save the incoming head stream to CSV")
    record.add_argument("path")
    record.add_argument("--port", type=int, default=DEFAULT_PORT)
    record.add_argument("--seconds", type=float, default=30)

    replay = commands.add_parser("replay", help="send a recording, standing in for the AirPods")
    replay.add_argument("path")
    replay.add_argument("--host", default="127.0.0.1")
    replay.add_argument("--port", type=int, default=DEFAULT_PORT)
    replay.add_argument("--loop", action="store_true")

    args = parser.parse_args()
    if args.command == "record":
        from .record import record as run_record

        print(f"{run_record(args.path, args.port, args.seconds)} packets -> {args.path}")
    elif args.command == "replay":
        from .record import replay as run_replay

        run_replay(args.path, args.host, args.port, args.loop)
    else:
        from .app import run as run_server

        run_server(getattr(args, "config", "headflight.toml"), not getattr(args, "no_phone", False))


if __name__ == "__main__":
    main()
