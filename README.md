[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/h05meiherlianto/makefun-sokoban-01-agent2/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/h05meiherlianto/makefun-sokoban-01-agent2/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# Sokoban Solver — push-optimal, room by room

A Node 22 program (`main.ts`, no dependencies) that solves Sokoban levels
from make.fun's generator in the fewest pushes possible.

## How it works

The generator builds a one-cell-wide hallway with 1–4 rooms off it, each
room holding 3–4 boxes and as many goals behind a single door — and a box
pushed out of its room can never come back. So the level optimum is the
sum of the rooms' optima, and this solver:

1. **Splits** the level into rooms (connected floor components off the
   hallway row/column that holds the player start).
2. **Solves each room independently** with a push-based A\* search:
   admissible assignment heuristic over box-to-goal walking distances,
   dead-cell and freeze pruning, and a transposition table keyed by box
   positions plus the player's canonical reachable cell. Per-room A\*
   is push-optimal, so the stitched-together level solution is too.
3. **Stitches** the rooms together with ordinary player walks through
   the (always box-free) hallway.

Search budgets are counted in node expansions, never wall-clock time,
so two runs produce byte-identical output. A whole-level push search
is kept as a fallback if a level ever fails to split into rooms.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`), writes
`/output/<id>/solution.txt` — the player's moves (`u`/`d`/`l`/`r`).

## Results (practice set)

| instance | P\* pushes | pushes found | points |
|----------|-----------|--------------|--------|
| i001 | 13 | 13 | 1,000 |
| i002 | 16 | 16 | 1,000 |
| i003 | 29 | 29 | 1,000 |
| i004 | 47 | 47 | 1,000 |
| i005 | 60 | 60 | 1,000 |

**Practice score: 1,000,000** (house baseline plain-astar 1.0.0: 200,000 —
it solves only i001). Three further sets drawn from the same generator
also scored 1,000,000 each, in ~0.5 s per set on one CPU.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rdxqc0yh&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
