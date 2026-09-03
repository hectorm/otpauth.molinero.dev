import * as OTPAuth from "otpauth";
import encodeQR from "qr";
import decodeQR from "qr/decode.js";
import { QRCanvas, QRCamera, frameLoop } from "qr/dom.js";

const $settings = document.querySelector("#settings");
const $code = document.querySelector("#code");
const $counter = document.querySelector("#counter");
const $uri = document.querySelector("#uri");
const $qr = document.querySelector("#qr");
const $cameraModal = document.querySelector("#camera-modal");
const $cameraPlayer = document.querySelector("#camera-player");
const $cameraOverlay = document.querySelector("#camera-overlay");
const $cameraList = document.querySelector("#camera-list");
const $load = document.querySelector("#load");

let totp = null;

const generate = () => {
  if (!$settings.checkValidity()) return;

  const settings = new FormData($settings);
  totp = new OTPAuth.TOTP({
    issuer: settings.get("issuer")?.toString(),
    label: settings.get("label")?.toString(),
    algorithm: settings.get("algorithm")?.toString(),
    digits: Number.parseInt(settings.get("digits")?.toString(), 10),
    period: Number.parseInt(settings.get("period")?.toString(), 10),
    secret: settings.get("secret")?.toString(),
  });

  $code.value = totp.generate();
  $uri.value = totp.toString();

  const svg = new DOMParser().parseFromString(
    encodeQR($uri.value, "svg", { ecc: "medium", scale: 1, border: 1 }),
    "image/svg+xml",
  );
  svg.documentElement.setAttribute("shape-rendering", "crispEdges");

  const qr = new XMLSerializer().serializeToString(svg);
  $qr.src = URL.createObjectURL(new Blob([qr], { type: "image/svg+xml" }));
};

const load = (otp) => {
  if (!(otp instanceof OTPAuth.TOTP)) {
    throw new Error("Only TOTP is supported");
  }

  if (otp.digits < $settings["digits"].min || otp.digits > $settings["digits"].max) {
    throw new Error("Digits out of range");
  }

  if (otp.period < $settings["period"].min || otp.period > $settings["period"].max) {
    throw new Error("Period out of range");
  }

  $settings["issuer"].value = otp.issuer;
  $settings["label"].value = otp.label;
  $settings["algorithm"].value = otp.algorithm;
  $settings["digits"].value = otp.digits;
  $settings["digits"].dispatchEvent(new Event("input", { bubbles: true }));
  $settings["period"].value = otp.period;
  $settings["period"].dispatchEvent(new Event("input", { bubbles: true }));
  $settings["secret"].value = otp.secret.base32;

  $settings.dispatchEvent(new Event("change", { bubbles: true }));
};

const progress = () => {
  if (!totp) return;

  $code.value = totp.generate();

  const vnow = totp.remaining();
  const vmax = totp.period * 1000;
  $counter.style.width = `${(vnow / vmax) * 100}%`;
  $counter.setAttribute("aria-valuenow", vnow.toString());
  $counter.setAttribute("aria-valuemax", vmax.toString());
};

const notify = (() => {
  const $toastContainer = document.querySelector("#toast-container");
  const $toastTemplate = document.querySelector("#toast-template");

  return (message, variant = "primary", duration = 5000) => {
    const clone = $toastTemplate.content.cloneNode(true);

    const $toast = clone.querySelector(".toast");
    $toast.classList.add(`text-bg-${variant}`);

    const $toastBody = clone.querySelector(".toast-body");
    $toastBody.textContent = message;

    $toastContainer.appendChild($toast);

    const bs = globalThis.bootstrap.Toast.getOrCreateInstance($toast);
    bs.show();

    setTimeout(() => {
      bs.hide();
      $toast.addEventListener("hidden.bs.toast", () => $toast.remove());
    }, duration);
  };
})();

$settings.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement) {
    const nextSibling = event.target.nextElementSibling;
    if (nextSibling instanceof HTMLOutputElement) {
      const digits = event.target.step.split(".")?.[1]?.length ?? 0;
      const value = Number.parseFloat(event.target.value).toFixed(digits);
      nextSibling.value = value;
    }
  }
});

$settings.addEventListener("change", () => {
  if ($settings.reportValidity()) {
    generate();
  }
});

$load.addEventListener("change", (event) => {
  event.stopPropagation();

  if (!event.target.files?.length) return;

  const file = event.target.files[0];
  const reader = new FileReader();

  reader.addEventListener("load", async (event) => {
    try {
      if (!(event.target?.result instanceof ArrayBuffer)) return;

      let source;
      if (file.type === "image/svg+xml") {
        const parser = new DOMParser();
        const doc = parser.parseFromString(new TextDecoder().decode(event.target.result), file.type);

        // Fill background
        const rect = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("width", "100%");
        rect.setAttribute("height", "100%");
        rect.setAttribute("fill", "white");
        doc.documentElement.insertBefore(rect, doc.documentElement.firstChild);

        // If no dimensions are set, use viewBox
        const { width, height } = doc.documentElement.getBoundingClientRect();
        if (!width || !height) {
          const viewBox = doc.documentElement.getAttribute("viewBox")?.split(" ") ?? [];
          if (viewBox.length !== 4) return;
          doc.documentElement.setAttribute("width", viewBox[2]);
          doc.documentElement.setAttribute("height", viewBox[3]);
        }

        const blob = new Blob([new XMLSerializer().serializeToString(doc)], { type: file.type });
        source = new Image();
        source.src = URL.createObjectURL(blob);
        await new Promise((resolve, reject) => {
          source.onload = resolve;
          source.onerror = reject;
        });
      } else {
        source = new Blob([event.target.result], { type: file.type });
      }

      const bitmap = await globalThis.createImageBitmap(source);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);

      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      load(OTPAuth.URI.parse(decodeQR(data)));
      notify("Loaded QR code from file", "success");
    } catch (error) {
      console.error(error);
      notify(error.message ?? error, "danger");
    }
  });

  reader.readAsArrayBuffer(file);

  event.target.value = "";
});

let camera = null;
let cameraCanvas = null;
let cameraLoopCancel = null;

const acquireCamera = async (deviceId) => {
  if (camera) camera.stop();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      ...(deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: "environment" }),
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
  camera = new QRCamera($cameraPlayer, stream);
  return camera;
};

const cameraLoop = (player) => {
  let scanned = false;
  let reading = false;
  return frameLoop(async () => {
    if (scanned || reading || player.videoWidth === 0) return;

    reading = true;
    const data = await camera.readFrame(cameraCanvas).finally(() => (reading = false));
    if (scanned || !data) return;

    try {
      load(OTPAuth.URI.parse(data));
      notify("Loaded QR code from camera", "success");
    } catch (error) {
      console.error(error);
      notify(error.message ?? error, "danger");
    } finally {
      scanned = true;
      setTimeout(() => {
        globalThis.bootstrap.Modal.getOrCreateInstance($cameraModal).hide();
      }, 100);
    }
  }, player);
};

$cameraModal.addEventListener("show.bs.modal", async () => {
  try {
    camera = await acquireCamera();
    cameraCanvas ??= new QRCanvas({
      overlay: $cameraOverlay,
    }, {
      overlayMainColor: "rgba(0, 255, 0, 0.5)",
      overlayFinderColor: "rgba(0, 0, 255, 0.5)",
      overlaySideColor: "rgba(0, 0, 0, 0)",
      cropToSquare: true,
    });

    const activeDeviceId = camera.stream.getVideoTracks()[0]?.getSettings().deviceId;

    $cameraList.innerHTML = "";
    for (const device of await camera.listDevices()) {
      const $option = document.createElement("option");
      $option.value = device.deviceId;
      $option.textContent = device.label;
      $option.selected = device.deviceId === activeDeviceId;
      $cameraList.appendChild($option);
    }
  } catch (error) {
    console.error(error);
    notify(error.message ?? error, "danger");
  }
});

$cameraModal.addEventListener("hide.bs.modal", () => {
  try {
    if (camera) camera.stop();
    if (cameraCanvas) cameraCanvas.clear();
    if (cameraLoopCancel) cameraLoopCancel();
  } catch (error) {
    console.error(error);
    notify(error.message ?? error, "danger");
  }
});

$cameraPlayer.addEventListener("play", () => {
  if (cameraLoopCancel) cameraLoopCancel();
  cameraLoopCancel = cameraLoop($cameraPlayer);
});

$cameraList.addEventListener("change", async (event) => {
  try {
    await acquireCamera(event.target.value);
  } catch (error) {
    console.error(error);
    notify(error.message ?? error, "danger");
  }
});

$code.addEventListener("focus", () => $code.select());
$uri.addEventListener("focus", () => $uri.select());

$settings["secret"].value = new OTPAuth.Secret().base32;

generate();
progress();

setInterval(() => progress(), 1000);
