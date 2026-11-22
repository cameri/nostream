---
'nostream': patch
---

fix(nip09): collect the ids of a deletion request in one pass

`DeleteEventStrategy` built the list of event ids from the `e` tags of a kind-5 event with `[...eventIds, tag[1]]` inside a `reduce`, which copies everything collected so far for each tag. An event with several thousand `e` tags (a message can hold about 7,000) therefore blocked the worker for tens of milliseconds before a single id was looked up, and it did so on every such event. The ids are now collected in one pass, and an id that appears more than once is asked for once. Which events are deleted is unchanged.
