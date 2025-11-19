const FIELD_CONFIG = [
  { label: "Title", canonical: "title" },
  { label: "Username", canonical: "username" },
  { label: "Password", canonical: "password" },
  { label: "Last Modified", canonical: "last modified" },
];

const DEFAULT_COLUMNS = new Set(FIELD_CONFIG.map((field) => field.canonical));
const HASH_FIELDS = FIELD_CONFIG.map((field) => field.canonical);

class CsvPanel {
  constructor(root) {
    this.root = root;
    this.elements = {
      dropZone: root.querySelector('[data-role="drop-zone"]'),
      fileInput: root.querySelector('[data-role="file-input"]'),
      status: root.querySelector('[data-role="status"]'),
      columnList: root.querySelector('[data-role="column-list"]'),
      merkleTree: root.querySelector('[data-role="merkle-tree"]'),
      merkleControls: root.querySelector('[data-role="merkle-controls"]'),
      rootHashText: root.querySelector('[data-role="root-hash-text"]'),
      merkleLevels: root.querySelector('[data-role="merkle-levels"]'),
      copyPrefixButton: root.querySelector('[data-role="copy-prefix"]'),
      copyFullButton: root.querySelector('[data-role="copy-full"]'),
      clearButton: root.querySelector('[data-role="clear-data"]'),
    };

    this.state = {
      parsedHeaders: [],
      parsedEntries: [],
      activeFields: [],
      computationVersion: 0,
      currentRootPrefix: "",
      currentRootHash: "",
      latestHashes: [],
      lastMerkleData: null,
      highlightedHashes: new Set(),
    };

    this.onDataChange = null;

    this.initialize();
  }

  initialize() {
    this.elements.fileInput.addEventListener("change", (event) => {
      const [file] = event.target.files;
      this.handleFileInput(file);
    });

    this.setupDropZone();
    this.setupCopyButtons();
    this.setupClearButton();
    this.setStatus("Waiting for a CSV file…");
  }

  async handleFileInput(file) {
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (!parsed.headers.length) {
        this.setStatus(
          "Could not find any headers in that file. Please check the CSV.",
          true
        );
        this.resetData();
        return;
      }

      this.state.parsedHeaders = parsed.headers;
      this.state.parsedEntries = parsed.rows;
      this.state.activeFields = buildActiveFields(parsed.headers);

      if (!this.state.parsedEntries.length) {
        this.setStatus(
          `Loaded ${file.name}, but no data rows were found.`,
          true
        );
        this.resetData();
        return;
      }

      this.setStatus(
        `Loaded ${file.name}. Title, Username, Password, and Last Modified are available for hashing.`
      );
      this.renderColumns();
      this.updateResults();
    } catch (error) {
      console.error(error);
      this.setStatus("Something went wrong while reading the CSV.", true);
      this.resetData();
    }
  }

  renderColumns() {
    const columnList = this.elements.columnList;
    const { activeFields } = this.state;

    if (!activeFields.length) {
      columnList.classList.add("hidden");
      columnList.innerHTML = "";
      return;
    }

    columnList.innerHTML = "";
    columnList.classList.remove("hidden");

    for (const field of activeFields) {
      const wrapper = document.createElement("label");
      wrapper.className = "column-item";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "columns";
      checkbox.dataset.field = field.canonical;
      const hasHeader = Boolean(field.headerName);
      checkbox.disabled = !hasHeader;
      checkbox.checked = hasHeader && DEFAULT_COLUMNS.has(field.canonical);
      checkbox.addEventListener("change", () => {
        this.updateResults();
      });

      const labelText = document.createElement("span");
      labelText.textContent = hasHeader
        ? field.label
        : `${field.label} (missing)`;

      wrapper.appendChild(checkbox);
      wrapper.appendChild(labelText);
      columnList.appendChild(wrapper);
    }
  }

  getSelectedFields() {
    const selected = [];
    const { activeFields } = this.state;
    const { columnList } = this.elements;

    for (const field of activeFields) {
      if (!field.headerName) {
        continue;
      }

      const checkbox = columnList.querySelector(
        `input[type="checkbox"][data-field="${field.canonical}"]`
      );

      if (checkbox?.checked) {
        selected.push(field);
      }
    }

    return selected;
  }

  setStatus(message, isError = false) {
    this.elements.status.textContent = message;
    this.elements.status.style.color = isError ? "#c81e1e" : "#52606d";
  }

  setupDropZone() {
    const { dropZone, fileInput } = this.elements;

    ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
      dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });

    ["dragenter", "dragover"].forEach((eventName) => {
      dropZone.addEventListener(eventName, () => {
        dropZone.classList.add("drag-over");
        this.setStatus("Drop the CSV to load it.");
      });
    });

    ["dragleave", "drop"].forEach((eventName) => {
      dropZone.addEventListener(eventName, () => {
        dropZone.classList.remove("drag-over");
        if (!this.state.parsedEntries.length) {
          this.setStatus("Waiting for a CSV file…");
        }
      });
    });

    dropZone.addEventListener("drop", (event) => {
      const { files } = event.dataTransfer;
      if (!files?.length) {
        return;
      }
      const [file] = files;
      fileInput.value = "";
      this.handleFileInput(file);
    });
  }

  resetData() {
    this.state.computationVersion += 1;
    this.state.parsedHeaders = [];
    this.state.parsedEntries = [];
    this.state.activeFields = [];
    this.elements.columnList.innerHTML = "";
    this.elements.columnList.classList.add("hidden");
    this.renderMerkleTree(null);
    this.state.latestHashes = [];
    this.notifyChange();
  }

  async updateResults() {
    if (!this.state.parsedEntries.length) {
      this.state.latestHashes = [];
      this.renderMerkleTree(null);
      this.notifyChange();
      return;
    }

    const selectedFields = this.getSelectedFields();
    const selectedCanonical = selectedFields.map((field) => field.canonical);
    const runId = ++this.state.computationVersion;

    if (!selectedFields.length) {
      this.state.latestHashes = [];
      this.renderMerkleTree(null);
      this.notifyChange();
      return;
    }

    const hashes = [];
    const titleField = this.state.activeFields.find(
      (field) => field.canonical === "title" && field.headerName
    );

    for (const entry of this.state.parsedEntries) {
      if (runId !== this.state.computationVersion) {
        return;
      }

      const normalized = normalizeEntry(entry, selectedFields);
      const hashInput = buildHashInput(normalized, selectedCanonical);
      const merkleHash = await sha256Hex(hashInput);

      if (runId !== this.state.computationVersion) {
        return;
      }

      const canonicalJson = canonicalizeEntry(entry, selectedFields);
      const canonicalHash = await sha256Hex(canonicalJson);

      if (runId !== this.state.computationVersion) {
        return;
      }

      const titleValue = titleField
        ? normalizeText(entry[titleField.headerName])
        : "";

      hashes.push({ merkleHash, canonicalHash, title: titleValue });
    }

    if (runId !== this.state.computationVersion) {
      return;
    }

    hashes.sort((a, b) => a.canonicalHash.localeCompare(b.canonicalHash));

    const leafNodes = hashes.map(({ merkleHash, title }) => ({
      hash: merkleHash,
      title,
    }));

    const merkleData = await buildMerkleTree(leafNodes);
    if (runId !== this.state.computationVersion) {
      return;
    }
    this.state.latestHashes = leafNodes;
    this.renderMerkleTree(merkleData);
    this.notifyChange();
  }

  setupCopyButtons() {
    const buttons = [
      {
        button: this.elements.copyPrefixButton,
        source: () => this.state.currentRootPrefix,
      },
      {
        button: this.elements.copyFullButton,
        source: () => this.state.currentRootHash,
      },
    ];

    buttons.forEach(({ button, source }) => {
      if (!button) {
        return;
      }
      button.dataset.defaultLabel = button.textContent;
      button.addEventListener("click", async () => {
        const value = source();
        if (!value) {
          return;
        }
        const defaultLabel = button.dataset.defaultLabel || button.textContent;
        try {
          await copyTextToClipboard(value);
          button.textContent = "Copied!";
          button.disabled = true;
          setTimeout(() => {
            button.textContent = defaultLabel;
            button.disabled = false;
          }, 1500);
        } catch (error) {
          console.error(error);
          this.setStatus("Unable to copy hash. Please try manually.", true);
        }
      });
    });
  }

  resetCopyButtons() {
    [this.elements.copyPrefixButton, this.elements.copyFullButton].forEach(
      (button) => {
        if (button) {
          const defaultLabel = button.dataset.defaultLabel || button.textContent;
          button.textContent = defaultLabel;
          button.disabled = false;
        }
      }
    );
  }

  setupClearButton() {
    this.elements.clearButton.addEventListener("click", () => {
      this.clearAll();
    });
  }

  clearAll() {
    this.elements.fileInput.value = "";
    this.resetData();
    this.setStatus("Waiting for a CSV file…");
  }

  renderMerkleTree(treeData) {
    const { merkleTree, merkleControls, rootHashText, merkleLevels } =
      this.elements;
    this.state.lastMerkleData = treeData;

    if (!treeData) {
      merkleTree.classList.add("hidden");
      merkleControls.classList.add("hidden");
      rootHashText.textContent = "";
      merkleLevels.innerHTML = "";
      this.resetCopyButtons();
      this.state.currentRootPrefix = "";
      this.state.currentRootHash = "";
      this.state.highlightedHashes = new Set();
      return;
    }

    merkleTree.classList.remove("hidden");
    merkleControls.classList.remove("hidden");

    const { root, levels } = treeData;
    const prefix = root.slice(0, 7);
    const remainder = root.slice(7);
    rootHashText.innerHTML = `<span class="root-prefix">${prefix}</span>${remainder}`;

    this.state.currentRootPrefix = prefix;
    this.state.currentRootHash = root;
    this.resetCopyButtons();

    merkleLevels.innerHTML = "";
    const orderedLevels = [...levels].map((level) => [...level]).reverse();
    const highlightSet =
      this.state.highlightedHashes instanceof Set
        ? this.state.highlightedHashes
        : new Set();

    orderedLevels.forEach((levelNodes, index) => {
      const realLevelIndex = levels.length - 1 - index;

      const levelEl = document.createElement("div");
      levelEl.className = "merkle-level";

      const label = document.createElement("div");
      label.className = "level-label";
      if (realLevelIndex === levels.length - 1) {
        label.textContent = "Root";
      } else if (realLevelIndex === 0) {
        label.textContent = "Entries";
      } else {
        label.textContent = `Level ${realLevelIndex}`;
      }

      const nodesWrapper = document.createElement("div");
      nodesWrapper.className = "merkle-nodes";

      levelNodes.forEach((node) => {
        const nodeEl = document.createElement("div");
        nodeEl.className = "merkle-node";
        if (node.isDuplicate) {
          nodeEl.classList.add("duplicate");
        }

        const hashValue = node.hash || "";
        const isDiff =
          realLevelIndex === 0 &&
          !node.isDuplicate &&
          highlightSet.has(hashValue);
        if (isDiff) {
          nodeEl.classList.add("diff");
        }

        if (node.title) {
          const titleEl = document.createElement("span");
          titleEl.className = "node-title";
          titleEl.textContent = `Title: ${node.title}`;
          nodeEl.appendChild(titleEl);
        }

        const hashEl = document.createElement("code");
        hashEl.textContent = node.hash;
        nodeEl.appendChild(hashEl);

        nodesWrapper.appendChild(nodeEl);
      });

      levelEl.appendChild(label);
      levelEl.appendChild(nodesWrapper);
      merkleLevels.appendChild(levelEl);
    });
  }

  setChangeHandler(handler) {
    this.onDataChange = handler;
  }

  notifyChange() {
    if (typeof this.onDataChange === "function") {
      this.onDataChange(this);
    }
  }

  getHashes() {
    return this.state.latestHashes || [];
  }

  setDifferences(hashSet = new Set()) {
    this.state.highlightedHashes =
      hashSet instanceof Set ? new Set(hashSet) : new Set();
    if (this.state.lastMerkleData) {
      this.renderMerkleTree(this.state.lastMerkleData);
    }
  }
}

function buildActiveFields(headers) {
  return FIELD_CONFIG.map((field) => {
    const headerName =
      headers.find((header) => toCanonical(header) === field.canonical) ?? null;
    return { ...field, headerName };
  });
}

function normalizeEntry(entry, selectedFields) {
  const normalized = {};

  for (const field of selectedFields) {
    const canonical = field.canonical;
    const rawValue = entry[field.headerName];
    normalized[canonical] =
      canonical === "last modified"
        ? normalizeDate(rawValue)
        : normalizeText(rawValue);
  }

  return normalized;
}

function canonicalizeEntry(entry, selectedFields) {
  const canonicalObject = {};
  const sortedFields = [...selectedFields].sort((a, b) =>
    a.canonical.localeCompare(b.canonical)
  );

  for (const field of sortedFields) {
    if (!field.headerName) {
      continue;
    }

    const canonical = field.canonical;
    const rawValue = entry[field.headerName];
    canonicalObject[canonical] =
      canonical === "last modified"
        ? normalizeDate(rawValue)
        : normalizeText(rawValue);
  }

  return JSON.stringify(canonicalObject);
}

function buildHashInput(normalizedEntry, selectedCanonical) {
  const selectedSet = new Set(selectedCanonical);
  const parts = [];

  for (const field of HASH_FIELDS) {
    if (!selectedSet.has(field)) {
      continue;
    }
    parts.push(normalizedEntry[field] ?? "");
  }

  return parts.join("|");
}

function normalizeText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value).trim();
  if (!text) {
    return "";
  }
  return text.replace(/\s+/g, " ").normalize("NFC");
}

function normalizeDate(value) {
  const normalizedText = normalizeText(value);
  if (!normalizedText) {
    return "";
  }

  const parsedDate = parseFlexibleDate(normalizedText);
  if (!parsedDate) {
    return "";
  }

  return formatUtcIso(parsedDate);
}

function parseFlexibleDate(value) {
  const isoMatch = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(?: ?(Z|[+-]\d{2}:\d{2}))?$/i
  );

  if (isoMatch) {
    const [, year, month, day, hour, minute, second, millisecond, zone] =
      isoMatch;
    const ms = millisecond ? millisecond.padEnd(3, "0").slice(0, 3) : "000";
    const baseTime = [hour ?? "00", minute ?? "00", second ?? "00"].map(
      (segment) => segment.padStart(2, "0")
    );
    const core = `${year}-${month}-${day}T${baseTime.join(":")}.${
      ms || "000"
    }`;

    if (zone) {
      const isoString = `${core}${zone === "Z" ? "Z" : zone}`;
      const offsetDate = new Date(isoString);
      if (!Number.isNaN(offsetDate.getTime())) {
        return offsetDate;
      }
    } else {
      const localDate = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour ?? 0),
        Number(minute ?? 0),
        Number(second ?? 0),
        Number(ms)
      );
      if (!Number.isNaN(localDate.getTime())) {
        return localDate;
      }
    }
  }

  const fallbackTimestamp = Date.parse(value);
  if (!Number.isNaN(fallbackTimestamp)) {
    return new Date(fallbackTimestamp);
  }

  return null;
}

function formatUtcIso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function toCanonical(value) {
  return (value || "").trim().toLowerCase();
}

async function sha256Hex(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function buildMerkleTree(leaves) {
  if (!leaves.length) {
    return null;
  }

  let currentLevel = leaves.map((leaf) => ({
    hash: leaf.hash,
    title: leaf.title,
    isDuplicate: false,
  }));

  const levels = [];

  while (true) {
    const workingLevel = currentLevel.map((node) => ({ ...node }));
    if (workingLevel.length > 1 && workingLevel.length % 2 === 1) {
      const last = workingLevel[workingLevel.length - 1];
      workingLevel.push({
        hash: last.hash,
        title: last.title,
        isDuplicate: true,
      });
    }

    levels.push(workingLevel);

    if (workingLevel.length === 1) {
      return { levels, root: workingLevel[0].hash };
    }

    const nextLevel = [];
    for (let i = 0; i < workingLevel.length; i += 2) {
      const left = workingLevel[i];
      const right = workingLevel[i + 1];
      const parentHash = await doubleSha256Hex(left.hash, right.hash);
      nextLevel.push({ hash: parentHash, title: null, isDuplicate: false });
    }

    currentLevel = nextLevel;
  }
}

async function doubleSha256Hex(leftHex, rightHex) {
  const leftBytes = hexToBytes(leftHex);
  const rightBytes = hexToBytes(rightHex);
  const combined = new Uint8Array(leftBytes.length + rightBytes.length);
  combined.set(leftBytes);
  combined.set(rightBytes, leftBytes.length);
  const first = await crypto.subtle.digest("SHA-256", combined);
  const second = await crypto.subtle.digest("SHA-256", first);
  return bytesToHex(new Uint8Array(second));
}

function hexToBytes(hex) {
  if (!hex) {
    return new Uint8Array();
  }
  const normalized = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  return new Promise((resolve, reject) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();

    try {
      const successful = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (successful) {
        resolve();
      } else {
        reject(new Error("Copy command failed"));
      }
    } catch (error) {
      document.body.removeChild(textarea);
      reject(error);
    }
  });
}

function parseCsv(text) {
  const source = text && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let currentRow = [];
  let currentValue = "";
  let isInQuotes = false;

  const pushValue = () => {
    currentRow.push(currentValue);
    currentValue = "";
  };

  const pushRowIfNeeded = () => {
    const isEmptyRow =
      currentRow.length === 1 && (currentRow[0] ?? "").length === 0;
    if (isEmptyRow && rows.length === 0) {
      currentRow = [];
      return;
    }

    if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== "")) {
      rows.push(currentRow);
    }
    currentRow = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const nextChar = source[i + 1];

    if (char === "\"" && nextChar === "\"") {
      currentValue += "\"";
      i += 1;
      continue;
    }

    if (char === "\"") {
      isInQuotes = !isInQuotes;
      continue;
    }

    if (char === "," && !isInQuotes) {
      pushValue();
      continue;
    }

    if ((char === "\n" || char === "\r") && !isInQuotes) {
      pushValue();
      if (char === "\r" && nextChar === "\n") {
        i += 1;
      }
      pushRowIfNeeded();
      continue;
    }

    currentValue += char;
  }

  pushValue();
  if (currentRow.length) {
    if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== "")) {
      rows.push(currentRow);
    }
  }

  if (!rows.length) {
    return { headers: [], rows: [] };
  }

  const headers = rows[0];
  const dataRows = rows.slice(1).map((row) => {
    const entry = {};
    headers.forEach((header, index) => {
      entry[header] = row[index] ?? "";
    });
    return entry;
  });

  return { headers, rows: dataRows };
}

document.addEventListener("DOMContentLoaded", () => {
  const controllers = {};
  document.querySelectorAll(".panel[data-panel]").forEach((panel) => {
    const key = panel.getAttribute("data-panel") || "";
    controllers[key] = new CsvPanel(panel);
  });

  const leftController = controllers.left;
  const rightController = controllers.right;
  const toggle = document.getElementById("dual-mode-toggle");
  const panelGrid = document.getElementById("panel-grid");

  const handleComparison = () => {
    const isDual = toggle?.checked ?? false;
    if (!isDual || !leftController || !rightController) {
      rightController?.setDifferences(new Set());
      return;
    }

    const leftHashes = new Set(
      (leftController.getHashes() || [])
        .map((entry) => entry.hash)
        .filter((hash) => Boolean(hash))
    );
    const rightHashes = rightController.getHashes() || [];

    if (!leftHashes.size || !rightHashes.length) {
      rightController.setDifferences(new Set());
      return;
    }

    const diffSet = new Set();
    rightHashes.forEach(({ hash }) => {
      if (hash && !leftHashes.has(hash)) {
        diffSet.add(hash);
      }
    });

    rightController.setDifferences(diffSet);
  };

  Object.values(controllers).forEach((controller) => {
    controller.setChangeHandler(handleComparison);
  });

  const updateMode = (isDual) => {
    if (panelGrid) {
      panelGrid.classList.toggle("dual-mode", isDual);
    }
    if (rightController?.root) {
      rightController.root.classList.toggle("hidden", !isDual);
      if (!isDual) {
        rightController.clearAll();
      }
    }
    handleComparison();
  };

  if (toggle) {
    updateMode(toggle.checked);
    toggle.addEventListener("change", () => {
      updateMode(toggle.checked);
    });
  } else {
    handleComparison();
  }
});
