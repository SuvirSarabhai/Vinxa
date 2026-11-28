import sys


if __name__ == "__main__":
    if '--cluster' in sys.argv:
        from sidecar.diarize import main
    else:
        from sidecar.server import main
    raise SystemExit(main())
