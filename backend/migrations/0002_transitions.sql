CREATE TABLE tunnel_state (
  tunnel_id TEXT PRIMARY KEY,
  scheduled_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('up','down','unknown','inactive')),
  raw_status TEXT NOT NULL,
  conns_active_at TEXT,
  conns_inactive_at TEXT,
  error TEXT
);
CREATE TABLE transitions (
  tunnel_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  raw_status TEXT NOT NULL,
  conns_active_at TEXT,
  conns_inactive_at TEXT,
  error TEXT,
  PRIMARY KEY(tunnel_id, scheduled_at)
);

-- Preserve existing history, compressing unchanged samples.
INSERT INTO transitions
WITH normalized AS (
  SELECT *, CASE WHEN status IN ('healthy','degraded') THEN 'up' ELSE status END AS state
  FROM observations
), ordered AS (
  SELECT *, LAG(state) OVER w AS previous_state, LAG(scheduled_at) OVER w AS previous_at
  FROM normalized WINDOW w AS (PARTITION BY tunnel_id ORDER BY scheduled_at)
)
SELECT tunnel_id, scheduled_at, observed_at, state, status, conns_active_at, conns_inactive_at, error
FROM ordered WHERE previous_state IS NULL OR state != previous_state
  OR unixepoch(scheduled_at) - unixepoch(previous_at) > 60;

INSERT INTO transitions
SELECT tunnel_id, strftime('%Y-%m-%dT%H:%M:%fZ', scheduled_at, '+1 minute'),
  strftime('%Y-%m-%dT%H:%M:%fZ', scheduled_at, '+1 minute'),
  'unknown', 'unknown', NULL, NULL, 'missed_check'
FROM (
  SELECT *, LEAD(scheduled_at) OVER (PARTITION BY tunnel_id ORDER BY scheduled_at) AS next_at
  FROM observations
) WHERE unixepoch(next_at) - unixepoch(scheduled_at) > 60;

INSERT INTO tunnel_state
SELECT tunnel_id, scheduled_at, observed_at,
  CASE WHEN status IN ('healthy','degraded') THEN 'up' ELSE status END,
  status, conns_active_at, conns_inactive_at, error
FROM observations o WHERE scheduled_at = (
  SELECT MAX(scheduled_at) FROM observations WHERE tunnel_id = o.tunnel_id
);

CREATE TRIGGER initial_state AFTER INSERT ON tunnel_state BEGIN
  INSERT INTO transitions VALUES (NEW.tunnel_id, NEW.scheduled_at, NEW.observed_at,
    NEW.status, NEW.raw_status, NEW.conns_active_at, NEW.conns_inactive_at, NEW.error);
END;
CREATE TRIGGER changed_state AFTER UPDATE ON tunnel_state BEGIN
  INSERT INTO transitions
  SELECT NEW.tunnel_id, strftime('%Y-%m-%dT%H:%M:%fZ', OLD.scheduled_at, '+1 minute'),
    strftime('%Y-%m-%dT%H:%M:%fZ', OLD.scheduled_at, '+1 minute'),
    'unknown', 'unknown', NULL, NULL, 'missed_check'
  WHERE unixepoch(NEW.scheduled_at) - unixepoch(OLD.scheduled_at) > 60;
  INSERT INTO transitions
  SELECT NEW.tunnel_id, NEW.scheduled_at, NEW.observed_at, NEW.status,
    NEW.raw_status, NEW.conns_active_at, NEW.conns_inactive_at, NEW.error
  WHERE NEW.status != OLD.status
    OR unixepoch(NEW.scheduled_at) - unixepoch(OLD.scheduled_at) > 60;
END;

DROP VIEW outages;
CREATE VIEW outages AS
WITH periods AS (
  SELECT *, LEAD(status) OVER w AS next_status, LEAD(observed_at) OVER w AS next_at
  FROM transitions WINDOW w AS (PARTITION BY tunnel_id ORDER BY scheduled_at)
)
SELECT tunnel_id, observed_at AS first_down_at,
  CASE WHEN next_status = 'up' THEN next_at END AS recovered_at,
  CASE WHEN next_status IS NULL THEN 'open'
    WHEN next_status = 'up' THEN 'recovered' ELSE 'uncertain' END AS outcome
FROM periods WHERE status = 'down';
