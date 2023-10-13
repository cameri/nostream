import { Event } from "../@types/event";

export const getPubkeysFromTags = (event: Event): string[] => {
  const pubkeys: string[] = [];
  for (let i = 0; i < event.tags.length; i++) {
    if (event.tags[i][0] === "p") {
      pubkeys.push(event.tags[i][1]);
    }
  }

  return pubkeys;
};
