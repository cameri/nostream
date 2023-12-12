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

CREATE OR REPLACE FUNCTION process_event_tags() RETURNS TRIGGER AS $$
DECLARE
  tag_element jsonb;
  tag_name text;
  tag_value text;
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    DELETE FROM event_tags WHERE event_id = OLD.event_id;
  END IF;

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



DO $$
DECLARE
  cur CURSOR FOR SELECT * FROM events ORDER BY event_id;
  row events%ROWTYPE;
  total_rows int;
  processed_rows int := 0;
BEGIN
  -- 全行数を取得
  SELECT count(*) INTO total_rows FROM events;

  -- カーソルを開く
  OPEN cur;

  LOOP
    -- カーソルから1000行取得
    FOR i IN 1..100 LOOP
      FETCH cur INTO row;
      EXIT WHEN NOT FOUND;

      -- ここで行の更新処理を行う
      UPDATE events SET event_id = row.event_id WHERE event_id = row.event_id;

      processed_rows := processed_rows + 1;
    END LOOP;

    RAISE NOTICE 'Processed: %, Total: %, Remaining: %, Percentage: %', processed_rows, total_rows, total_rows - processed_rows, format('%4s', processed_rows::DOUBLE PRECISION / total_rows::DOUBLE PRECISION * 100);

    -- すべての行が処理されたら終了
    EXIT WHEN NOT FOUND;

    -- 一定時間待機
    PERFORM pg_sleep(0.1);
  END LOOP;

  CLOSE cur;
END $$;