import { applySavedTheme, setUpThemeSwitch } from "../theme.js";

// Loaded in <head>, before the body exists: the theme now, the switch once
// the bar is there.
applySavedTheme();
document.addEventListener("DOMContentLoaded", setUpThemeSwitch);
