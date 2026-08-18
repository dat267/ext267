"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;

const isContentScript =
  typeof window !== "undefined" &&
  typeof location !== "undefined" &&
  (location.protocol === "http:" || location.protocol === "https:");

function shouldCapture({ protocol, title, html }) {
  if (protocol !== "http:" && protocol !== "https:") return false;
  if (!title && !html) return false;
  if (!html || !/<body[\s>]/i.test(html)) return false;
  return /[^\s<>{}/\\"']/.test(html.replace(/<[^>]*>/g, ""));
}

function extractSnapshot(doc) {
  return {
    url: doc.baseURI || "",
    title: doc.title || "",
    baseURI: doc.baseURI || "",
    html: (doc.documentElement && doc.documentElement.outerHTML) || "",
    ts: Date.now()
  };
}

function armSpaCapture(windowObj, locationObj, captureFn) {
  const listeners = [];
  const onNav = () => {
    setTimeout(() => captureFn(), 400);
  };
  for (const type of ["pushState", "replaceState", "popstate"])
    if (windowObj.addEventListener) {
      windowObj.addEventListener(type, onNav);
      listeners.push(() => windowObj.removeEventListener(type, onNav));
    }

  const navApi = windowObj.navigation;
  if (navApi && navApi.addEventListener) {
    navApi.addEventListener("navigate", onNav);
    listeners.push(() => navApi.removeEventListener("navigate", onNav));
  }
  void locationObj;
  return () => {
    listeners.splice(0).forEach((off) => off());
  };
}

if (isContentScript) {
  const run = async () => {
    const settings = await ext.storage.local.get("archivr.enabled").catch(() => ({}));
    if (!settings["archivr.enabled"]) return;

    const shot = extractSnapshot(document);
    if (!shouldCapture({ protocol: location.protocol, title: shot.title, html: shot.html })) return;

    let lastSent = 0;
    const send = () => {
      if (Date.now() - lastSent < 5000) return;
      lastSent = Date.now();
      ext.runtime.sendMessage(["archivr:capture", shot]);
    };

    send();
    armSpaCapture(window, location, send);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
}
