"use client";

export function PrintButton() {
  return <button className="btn primary certificate-controls" type="button" onClick={() => window.print()}>Print / Save as PDF</button>;
}
