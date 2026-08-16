"use client";

// Conduit's colours for Circle's modal.
//
// Circle's PIN and challenge UI runs inside an iframe on Circle's origin, so it
// cannot be styled with our CSS — but the SDK accepts a theme and forwards it
// into the frame. Without this the payer's flow goes black-and-signal-green all
// the way to the moment they authorise a payment, then hands them a white and
// blue dialog from a company they have never heard of. That reads as a phishing
// step, not a confirmation, at the exact point trust matters most.
//
// Values come from globals.css rather than being re-typed, so a rebrand moves
// this too. Circle's theme takes hex strings, not CSS variables — the iframe
// cannot see our custom properties — so they are duplicated here deliberately
// and this comment is the reason why.
//
//   --bg          #050505   --signal      #B2F55A
//   --surface     #141712   --signal-ink  #050505
//   --border      #2A3122   --danger      #F5655A
//   --ink         #E8EAE0   --ink-dim     #6B7060

const BG = "#050505";
const SURFACE = "#141712";
const BORDER = "#2A3122";
const INK = "#E8EAE0";
const INK_DIM = "#6B7060";
const SIGNAL = "#B2F55A";
const SIGNAL_INK = "#050505";
const DANGER = "#F5655A";

export const circleThemeColor = {
  backdrop: BG,
  backdropOpacity: 0.7,
  bg: SURFACE,
  divider: BORDER,

  success: SIGNAL,
  error: DANGER,

  textMain: INK,
  textAuxiliary: INK_DIM,
  textSummary: INK,
  textSummaryHighlight: SIGNAL,
  textPlaceholder: INK_DIM,
  textDetailToggle: SIGNAL,
  textInteractive: SIGNAL,
  interactiveBg: SURFACE,

  tooltipText: BG,
  tooltipBg: SIGNAL,

  // The PIN dots are the most-looked-at element in the whole flow.
  pinDotBase: SURFACE,
  pinDotBaseBorder: BORDER,
  pinDotActivated: SIGNAL,
  enteredPinText: INK,

  inputText: INK,
  inputBg: SURFACE,
  inputBgDisabled: BG,
  inputBorderFocused: SIGNAL,
  inputBorderFocusedError: DANGER,

  dropdownBg: SURFACE,
  dropdownBorderIsOpen: SIGNAL,
  dropdownBorderError: DANGER,

  mainBtnText: SIGNAL_INK,
  mainBtnTextDisabled: INK_DIM,
  mainBtnBg: SIGNAL,
  mainBtnBgDisabled: BORDER,

  secondBtnText: INK,
  secondBtnTextOnHover: SIGNAL,
  secondBtnTextDisabled: INK_DIM,
  secondBtnBorder: BORDER,
  secondBtnBorderOnHover: SIGNAL,
  secondBtnBorderDisabled: BORDER,
} as const;
