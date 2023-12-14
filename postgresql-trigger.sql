CREATE TABLE IF NOT EXISTS public.event_tags
(
    id uuid NOT NULL DEFAULT uuid_generate_v4(),
    event_id bytea NOT NULL,
    tag_name text COLLATE pg_catalog."default" NOT NULL,
    tag_value text COLLATE pg_catalog."default" NOT NULL,
    CONSTRAINT event_tags_pkey PRIMARY KEY (id)
)
TABLESPACE pg_default;

ALTER TABLE IF EXISTS public.event_tags
    OWNER to nostr_ts_relay;

CREATE INDEX IF NOT EXISTS event_tags_tag_name_tag_value_index
    ON public.event_tags USING btree
    (tag_name COLLATE pg_catalog."default" ASC NULLS LAST, tag_value COLLATE pg_catalog."default" ASC NULLS LAST)
    TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS event_tags_tag_name_tag_value_hash_index
    ON public.event_tags USING btree
    (tag_name COLLATE pg_catalog."default" ASC NULLS LAST, md5(tag_value) COLLATE pg_catalog."default" ASC NULLS LAST)
    TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS event_tags_event_id_index
    ON public.event_tags USING btree
    (event_id ASC NULLS LAST)
    WITH (deduplicate_items=True)
    TABLESPACE pg_default;

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


CREATE OR REPLACE FUNCTION process_event_tags_direct(event_row events) RETURNS VOID AS $$
DECLARE
  tag_element jsonb;
  tag_name text;
  tag_value text;
BEGIN
  DELETE FROM event_tags WHERE event_id = event_row.event_id;

  FOR tag_element IN SELECT jsonb_array_elements(event_row.event_tags)
  LOOP
    tag_name := trim((tag_element->0)::text, '"');
    tag_value := trim((tag_element->1)::text, '"');
    IF length(tag_name) = 1 AND tag_value IS NOT NULL AND tag_value <> '' THEN
      INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (event_row.event_id, tag_name, tag_value);
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;


DO $$
DECLARE
  cur CURSOR FOR SELECT * FROM events ORDER BY event_id;
  row events%ROWTYPE;
  total_rows int;
  processed_rows int := 0;
BEGIN
  -- 全行数を取得
  SELECT count(*) INTO total_rows FROM events;

  OPEN cur;

  WHILE processed_rows < total_rows LOOP
    FOR i IN 1..100 LOOP
      FETCH NEXT FROM cur INTO row;
      EXIT WHEN NOT FOUND;

      -- process_event_tagsを直接呼び出す
      PERFORM process_event_tags_direct(row);

      processed_rows := processed_rows + 1;
    END LOOP;

    -- 進捗%を出力
    RAISE NOTICE 'Processed: %, Total: %, Remaining: %, Percentage: %', processed_rows, total_rows, total_rows - processed_rows, (processed_rows::float / total_rows::float * 100);
    -- 1秒待機
    PERFORM pg_sleep(0.1);
  END LOOP;

  CLOSE cur;
END $$;
















CREATE OR REPLACE FUNCTION process_event_tags_direct(event_row events) RETURNS VOID AS $$
DECLARE
  tag_element jsonb;
  tag_name text;
  tag_value text;
  exists_flag boolean;
BEGIN
  -- 既に処理されたevent_idがあればスキップ
  SELECT EXISTS(SELECT 1 FROM event_tags WHERE event_id = event_row.event_id) INTO exists_flag;
  IF exists_flag THEN
    RETURN;
  END IF;

  FOR tag_element IN SELECT jsonb_array_elements(event_row.event_tags)
  LOOP
    tag_name := trim((tag_element->0)::text, '"');
    tag_value := trim((tag_element->1)::text, '"');
    IF length(tag_name) = 1 AND tag_value IS NOT NULL AND tag_value <> '' THEN
      INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (event_row.event_id, tag_name, tag_value);
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
