"""Compare a StreamLine capture against a reference track.

Each module owns one concern: `signal` is the shared stereo-frame type and its
format constants, `decode` turns files into frames (ffmpeg or raw s16le),
`align` recovers the capture-to-reference lag, `transform` scores channel
mappings, `measure` reports level and spectral statistics, and `report` renders
those typed results and owns the `streamline-analyze` CLI.
"""
