"use strict";

// Permission add/remove/resolve may finish without another lifecycle event.
// Coalesce the current facts after the permission owner's synchronous mutation.
module.exports = function createPermissionPresentationRefresh(options = {}) {
  const schedule = options.schedule || queueMicrotask;
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      if (options.isDisposed?.()) return;
      options.getStateRuntime?.()?.refreshCodexPendingAttention?.();
    });
  };
};
