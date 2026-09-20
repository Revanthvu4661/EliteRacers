// device.js - one-time device classification. Touch UI and the mobile render-quality path both key off this.
// Override for testing: ?touch=1 forces touch/mobile mode, ?touch=0 forces it off.
const qs = new URLSearchParams(location.search).get("touch");
const coarse = window.matchMedia && matchMedia("(pointer: coarse)").matches;
const hasTouch = "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
// Primary pointer is a finger (phones/tablets), or a touch device with a small viewport.
// Desktops and touchscreen laptops (primary pointer = mouse) stay false.
export const isTouchDevice = qs === "1" ? true : qs === "0" ? false : (coarse || (hasTouch && Math.min(screen.width, screen.height) <= 820));
export const isMobile = isTouchDevice;

if (isTouchDevice) document.documentElement.classList.add("touch");
