"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;

const isContentScript =
  typeof window !== "undefined" &&
  typeof location !== "undefined" &&
  (location.protocol === "http:" || location.protocol === "https:");

// Content-script logic is added in Task 4. This guard keeps the file inert
// if it is ever loaded in a non-page context.
if (isContentScript) void ext;
