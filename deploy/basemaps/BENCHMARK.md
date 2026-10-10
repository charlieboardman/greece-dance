# Terrain sample benchmark

The direct-HGT renderer was tested locally in a QEMU/KVM Debian 12 VM with one vCPU, 1 GiB RAM, no swap, and 106.2 MB reserved for the application footprint. The entire VM was capped at 12.5 ms CPU time per 100 ms (one eighth of one local Ryzen AI Max+ 395 core). This is an assumed pessimistic scenario, not a calibrated or guaranteed DigitalOcean CPU lower bound.

The renderer ran inside a 300 MiB memory cgroup. Four-tile chunks, one WebP encoder, quality 76; full atlas hydrography loaded. Eighteen real HGT granules supplied two 3×3° samples. Sampling/shading/hydrography/encoding/SQLite writes were measured; downloading and PMTiles packaging were not.

| Sample | Zoom | Tiles | Seconds | Tiles/s |
|---|---:|---:|---:|---:|
| western-greece | 8 | 12 | 10.10 | 1.19 |
| western-greece | 9 | 35 | 21.60 | 1.62 |
| western-greece | 10 | 120 | 55.11 | 2.18 |
| western-greece | 11 | 414 | 149.50 | 2.77 |
| northeastern-turkey | 8 | 9 | 7.30 | 1.23 |
| northeastern-turkey | 9 | 36 | 22.69 | 1.59 |
| northeastern-turkey | 10 | 120 | 57.10 | 2.10 |
| northeastern-turkey | 11 | 414 | 155.20 | 2.67 |

Total: 1,160 tiles in 478.6 seconds (2.42 tiles/s). Peak process RSS 140.0 MiB; cgroup peak 130.5 MiB. No memory-limit hits or OOM events.

Weighting by the 23,879 full-atlas tile counts gives **184 minutes** of rendering in this scenario. Unmeasured zooms 0–7 use the zoom-8 rate.

The small input fits in cache. The VM disk image was hosted on tmpfs, so this does not measure production disk performance or prove the full dataset fits the memory/disk limits. The build preflight checks free disk space, and source reads/working arrays are bounded. Unit tests compare direct source reads and chunk halos to the original full-mosaic method. A complete atlas build was not run as part of this sample test.
