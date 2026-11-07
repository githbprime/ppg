(function () {
  "use strict";

  const defaultConfig = {
    files: [],
    basePath: "", 
    debug: true,
  };

  const config = Object.assign(
    {},
    defaultConfig,
    window.fileMergerConfig || {},
  );

  const mergeStatus = {};
  const mergeProgress = {};
  const blobPromises = {};

  let loadingDiv;
  let loadingContent;

  function initializeUI() {
    if (document.getElementById("file-merger-loading")) return;
    loadingDiv = document.createElement("div");
    loadingDiv.id = "file-merger-loading";
    loadingDiv.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(0, 0, 0, 0.9);
      color: white;
      padding: 30px 40px;
      border-radius: 10px;
      font-family: monospace;
      font-size: 16px;
      z-index: 10000;
      min-width: 300px;
      text-align: center;
    `;

    loadingContent = document.createElement("div");
    loadingContent.id = "file-merger-content";
    loadingDiv.appendChild(loadingContent);
    document.body.appendChild(loadingDiv);
  }

  function updateLoadingDisplay() {
    if (!loadingContent) return;

    const lines = [
      '<div style="font-size: 18px; margin-bottom: 15px;">Merging files...</div>',
    ];

    config.files.forEach((file) => {
      const status = mergeStatus[file.name] || "waiting";
      const progress = mergeProgress[file.name] || {
        current: 0,
        total: file.parts,
      };

      let statusText = "";
      let color = "#888";

      if (status === "merging") {
        statusText = ` merging... ${progress.current}/${progress.total}`;
        color = "#ffa500";
      } else if (status === "ready") {
        statusText = "done";
        color = "#00ff00";
      } else if (status === "failed") {
        statusText = "failed";
        color = "#ff0000";
      } else {
        statusText = "Waiting...";
      }

      lines.push(
        `<div style="margin: 8px 0; color: ${color};">${file.name}: ${statusText}</div>`,
      );
    });
    loadingContent.innerHTML = lines.join("");

    const allDone = config.files.every(
      (file) =>
        mergeStatus[file.name] === "ready" ||
        mergeStatus[file.name] === "failed",
    );

    if (allDone) {
      setTimeout(() => {
        if (loadingDiv) {
          loadingDiv.style.opacity = "0";
          loadingDiv.style.transition = "opacity 0.5s";
          setTimeout(() => loadingDiv.remove(), 500);
        }
      }, 1000);
    }
  }

  function log(...args) {
    if (config.debug) console.log("[FileMerger]", ...args);
  }

  function error(...args) {
    console.error("[FileMerger]", ...args);
  }

  function normalizeUrl(url) {
    if (!url) return "";
    try {
      return decodeURIComponent(url.toString().split("?")[0]);
    } catch (e) {
      return url.toString();
    }
  }

  function urlsMatch(url1, url2) {
    const norm1 = normalizeUrl(url1);
    const norm2 = normalizeUrl(url2);

    if (norm1 === norm2) return true;
    if (norm1.endsWith(norm2) || norm2.endsWith(norm1)) return true;

    return norm1.split("/").pop() === norm2.split("/").pop();
  }

  async function mergeSplitFiles(filePath, numParts) {
    const fileName = filePath.split("/").pop();
    mergeProgress[fileName] = { current: 0, total: numParts };
    updateLoadingDisplay();

    try {
      const parts = [];
      for (let i = 1; i <= numParts; i++) {
        parts.push(`${filePath}.part${i}`);
      }

      log(`Merging ${filePath} from ${numParts} parts...`);

      const blobs = [];
      for (let i = 0; i < parts.length; i++) {
        const response = await window.originalFetch(parts[i]);

        if (!response.ok) {
          throw new Error(
            `Failed to load part ${parts[i]}: ${response.status}`,
          );
        }

        const blob = await response.blob();
        blobs.push(blob);

        mergeProgress[fileName].current = i + 1;
        updateLoadingDisplay();
      }

      const contentType = fileName.endsWith(".wasm")
        ? "application/wasm"
        : "application/octet-stream";

      // Combine Blob chunks with 0 RAM duplication
      const mergedBlob = new Blob(blobs, { type: contentType });
      const blobUrl = URL.createObjectURL(mergedBlob);

      log(` ${filePath} done: ${(mergedBlob.size / 1024 / 1024).toFixed(2)} MB`);
      return blobUrl;
    } catch (err) {
      error(`Failed to merge ${filePath}:`, err);
      throw err;
    }
  }

  function shouldInterceptFile(url) {
    if (!url) return null;
    const urlStr = normalizeUrl(url);
    if (urlStr.includes(".part")) return null;

    for (const file of config.files) {
      const fileName = file.name;
      const fullPath = config.basePath
        ? `${config.basePath}${fileName}`
        : fileName;

      if (
        urlsMatch(urlStr, fileName) ||
        urlsMatch(urlStr, fullPath) ||
        urlsMatch(urlStr, fileName + ".br") ||
        urlsMatch(urlStr, fullPath + ".br")
      ) {
        return fileName;
      }
    }

    return null;
  }

  function waitForBlobUrl(filename) {
    if (blobPromises[filename]) {
      return blobPromises[filename];
    }
    for (const [key, promise] of Object.entries(blobPromises)) {
      if (urlsMatch(key, filename)) return promise;
    }
    return Promise.reject(
      new Error(`File not configured for merger: ${filename}`),
    );
  }

  // Intercept Fetch
  if (!window.originalFetch) window.originalFetch = window.fetch;

  window.fetch = function (url, ...args) {
    const filename = shouldInterceptFile(url);

    if (filename) {
      log("Intercepting fetch for:", filename);
      return waitForBlobUrl(filename).then((blobUrl) => {
        return window.originalFetch.call(this, blobUrl, ...args);
      });
    }

    return window.originalFetch.call(this, url, ...args);
  };

  // Intercept XHR cleanly
  if (!window.OriginalXMLHttpRequest)
    window.OriginalXMLHttpRequest = window.XMLHttpRequest;

  window.XMLHttpRequest = function (options) {
    const xhr = new window.OriginalXMLHttpRequest(options);
    const originalOpen = xhr.open;
    const originalSend = xhr.send;

    let interceptedFilename = null;
    let openArgs = null;

    xhr.open = function (method, url, ...args) {
      interceptedFilename = shouldInterceptFile(url);
      if (interceptedFilename) {
        openArgs = { method, url, args };
        return originalOpen.call(this, method, url, ...args);
      }
      return originalOpen.call(this, method, url, ...args);
    };

    xhr.send = function (...args) {
      if (interceptedFilename) {
        log("Intercepting XHR send for:", interceptedFilename);

        waitForBlobUrl(interceptedFilename)
          .then((blobUrl) => {
            const savedResponseType = xhr.responseType;
            originalOpen.call(this, openArgs.method, blobUrl, ...openArgs.args);
            if (savedResponseType) {
              try {
                xhr.responseType = savedResponseType;
              } catch (e) {}
            }
            originalSend.call(this, ...args);
          })
          .catch((err) => {
            error("XHR merge failed for", interceptedFilename, err);
            const errorEvent = new Event("error");
            xhr.dispatchEvent(errorEvent);
            if (xhr.onerror) xhr.onerror(errorEvent);
          });
        return;
      }

      return originalSend.call(this, ...args);
    };

    return xhr;
  };

  async function autoMergeFiles() {
    if (!config.files.length) return;

    updateLoadingDisplay();

    config.files.forEach((file) => {
      const fullPath = config.basePath
        ? `${config.basePath}${file.name}`
        : file.name;

      const promise = (async () => {
        mergeStatus[file.name] = "merging";
        updateLoadingDisplay();
        try {
          const blobUrl = await mergeSplitFiles(fullPath, file.parts);
          mergeStatus[file.name] = "ready";
          updateLoadingDisplay();
          return blobUrl;
        } catch (err) {
          mergeStatus[file.name] = "failed";
          updateLoadingDisplay();
          throw err;
        }
      })();

      blobPromises[file.name] = promise;
      blobPromises[fullPath] = promise;
    });
  }

  function init() {
    if (document.body) {
      initializeUI();
      autoMergeFiles();
    } else {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
          initializeUI();
          autoMergeFiles();
        });
      } else {
        setTimeout(init, 10);
      }
    }
  }

  init();
})();
