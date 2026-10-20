CREATE TABLE event_tags (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id bytea NOT NULL,
    tag_name text NOT NULL,
    tag_value text NOT NULL
);

CREATE INDEX event_tags_event_id_index ON event_tags (event_id);
CREATE INDEX event_tags_tag_name_tag_value_index ON event_tags (tag_name, tag_value);

CREATE OR REPLACE FUNCTION process_event_tags() RETURNS TRIGGER AS $$
    DECLARE
      tag_element jsonb;
      tag_name text;
      tag_value text;
    BEGIN
      DELETE FROM event_tags WHERE event_id = OLD.event_id;

      IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        FOR tag_element IN SELECT jsonb_array_elements(NEW.event_tags)
        LOOP
          tag_name := trim((tag_element->0)::text, '"');
          tag_value := trim((tag_element->1)::text, '"');
          IF length(tag_name) = 1 AND tag_value IS NOT NULL AND tag_value <> '' THEN
            INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (NEW.event_id, tag_name, tag_value);
          END IF;
        END LOOP;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

CREATE TRIGGER insert_event_tags
AFTER INSERT OR UPDATE OR DELETE ON events
FOR EACH ROW
EXECUTE FUNCTION process_event_tags();

-- The set-based form of the capture's per-event loop: one row per one-character tag name
-- with a non-empty value, for every event that has no event_tags row yet.
INSERT INTO event_tags (event_id, tag_name, tag_value)
SELECT events.event_id,
       (tag_element->>0),
       (tag_element->>1)
FROM events
CROSS JOIN LATERAL jsonb_array_elements(events.event_tags) AS tag_element
WHERE NOT EXISTS (
    SELECT 1 FROM event_tags WHERE event_tags.event_id = events.event_id
)
AND length(tag_element->>0) = 1
AND (tag_element->>1) IS NOT NULL
AND (tag_element->>1) <> '';
