#!/bin/bash
# Generates any missing radio voices with macOS speech. They are made on your Mac rather than
# stored in this repository, because Apple's terms limit redistributing system voices.
mkdir -p "$(dirname "$0")/headflight/web/radio"
cd "$(dirname "$0")/headflight/web/radio" || exit 1

CONTROL="Samantha"
WINGMAN="Daniel"

line() {
  local voice="$1" name="$2" text="$3"
  [ -f "${name}.m4a" ] && return
  echo "Generating radio voice: $name"
  say -v "$voice" -r 195 -o "${name:?}.aiff" "$text" || say -r 195 -o "${name:?}.aiff" "$text" || exit 1
  afconvert -f m4af -d aac -b 32000 "${name}.aiff" "${name}.m4a" || exit 1
  rm -f "${name:?}.aiff"
}

line "$CONTROL" bandit_12 "Skywatch. Bandit, twelve o'clock."
line "$CONTROL" bandit_3 "Skywatch. Bandit, three o'clock."
line "$CONTROL" bandit_6 "Skywatch. Bandit, six o'clock. Watch your tail."
line "$CONTROL" bandit_9 "Skywatch. Bandit, nine o'clock."
line "$CONTROL" radar "Radar contact holding. Continue mission."
line "$CONTROL" fuel "Fuel state good. Maintain altitude."
line "$CONTROL" sector "Sector clear of new contacts. Stay sharp."
line "$WINGMAN" formation "Two, holding on your right wing."
line "$WINGMAN" check_six "Lead, check your six."
line "$WINGMAN" clear "Two, all clear on my side."
line "$WINGMAN" tally "Good eyes. Target in sight."
line "$WINGMAN" tally_again "Target confirmed. Stay on him."
line "$CONTROL" contact "Skywatch. New contact, off your nose."
line "$CONTROL" fight_on "Skywatch. Bandit on your nose, closing fast. Fight's on."
line "$CONTROL" hit "You're hit. Resetting the fight."
line "$WINGMAN" on_your_six "Break! He's on your six!"
line "$WINGMAN" fox_two "Good tone. Fox two."
line "$WINGMAN" splash "Splash one. Good kill."
