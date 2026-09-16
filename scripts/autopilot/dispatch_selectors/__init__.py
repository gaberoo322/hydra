"""Per-dispatch-class selector leaves split out of `decide.py` (issue #4511).

Never import this package for its own sake -- each submodule does `from decide import ...`
and is only ever loaded BY decide.py, after decide.py has defined the shared helpers
these selectors need (see the `sys.modules.setdefault` alias comment in decide.py).
"""
