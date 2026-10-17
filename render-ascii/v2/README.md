# Browser ASCII projection v2

Play uses this projection to retain empty room cells at every camera angle.
Angled views include the whole projected ground footprint, and every view
retains the full room width. Only off-room vertical padding is trimmed.

The scene compositor is forked from v1 because saved benchmark manifests pin
the v1 module bytes and observation layout. The v1 glyph contract, DOM painter,
and controller are reused. Existing benchmark observations remain unchanged.

Run `node --test tests/ascii-room-bounds.test.mjs` for the G×E regression,
rectangular rooms, empty rooms, negative heights, and seeded views.
