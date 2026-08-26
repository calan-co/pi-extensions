# Pi channel routing

`pi-channel` is Pi-native durable membership. Its local snapshots contain a
canonical Pi session-file path (or explicit `null`) alongside membership. The
paired relay alone obtains stock `GET /sessions/<WSS session ID>` metadata and
routes only a canonical exact path match with matching `.jsonl` filename IDs.
No adapter sends channel controls to Oppi. Missing, denied, ambiguous, or
mismatched metadata fails closed; manual relay bind is recovery only.
