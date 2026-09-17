CREATE TABLE observations (
  tunnel_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy','degraded','down','inactive','unknown')),
  conns_active_at TEXT,
  conns_inactive_at TEXT,
  error TEXT,
  PRIMARY KEY (tunnel_id, scheduled_at)
);

-- Each consecutive run of down observations is an event. Unknown/inactive
-- samples and missed minutes break continuity rather than inventing downtime.
CREATE VIEW outages AS
WITH ordered AS (
  SELECT *,
    LAG(status) OVER w AS previous_status,
    LAG(scheduled_at) OVER w AS previous_at,
    LEAD(status) OVER w AS next_status,
    LEAD(scheduled_at) OVER w AS next_at,
    LEAD(observed_at) OVER w AS next_observed_at
  FROM observations
  WINDOW w AS (PARTITION BY tunnel_id ORDER BY scheduled_at)
), grouped AS (
  SELECT *, SUM(CASE WHEN status = 'down' AND previous_status = 'down'
    AND unixepoch(scheduled_at) - unixepoch(previous_at) = 60 THEN 0 ELSE 1 END)
    OVER (PARTITION BY tunnel_id ORDER BY scheduled_at) AS segment
  FROM ordered
)
SELECT tunnel_id, MIN(observed_at) AS first_down_at,
  MAX(observed_at) AS last_down_at,
  MAX(CASE WHEN next_status IN ('healthy','degraded')
    AND unixepoch(next_at) - unixepoch(scheduled_at) = 60
    THEN next_observed_at END) AS recovered_at,
  CASE WHEN MAX(CASE WHEN next_at IS NULL THEN 1 ELSE 0 END) = 1 THEN 'open'
    WHEN MAX(CASE WHEN next_status IN ('healthy','degraded')
      AND unixepoch(next_at) - unixepoch(scheduled_at) = 60 THEN 1 ELSE 0 END) = 1
    THEN 'recovered' ELSE 'uncertain' END AS outcome,
  COUNT(*) AS down_samples
FROM grouped WHERE status = 'down'
GROUP BY tunnel_id, segment;
