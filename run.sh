#!/bin/bash
# Starts everything: the AirPods sender, the simulator server, and the page in your browser.
cd "$(dirname "$0")" || exit 1

if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
  echo "HeadFlight needs Python 3.11 or later. The one macOS includes is older: get one from python.org."
  exit 1
fi

if [ ! -d sender/build/AirTracker.app ]; then
  echo "Building the AirPods sender (first run only)..."
  sender/scripts/bundle.sh release || exit 1
fi

if ! ls sim/headflight/web/radio/*.m4a >/dev/null 2>&1; then
  echo "Generating radio voices (first run only)..."
  sim/make_voices.sh || exit 1
fi

stop_sender() { pkill -f "AirTracker.app/Contents/MacOS/AirTracker bridge"; }

stop_sender     # a killed terminal can leave one behind, playing silent audio
open -n sender/build/AirTracker.app --args bridge --host 127.0.0.1 --no-json
trap stop_sender EXIT
trap 'exit 0' HUP INT TERM
(sleep 2 && open http://127.0.0.1:4251) &

cd sim && python3 -m headflight run
