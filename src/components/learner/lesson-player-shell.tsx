"use client";

import React, { useState } from "react";

/**
 * Lesson classroom frame: sticky curriculum rail on desktop, course-contents
 * drawer on mobile (React state — no dependency on prototype demo scripts).
 */
export function LessonPlayerShell({
  curriculumNav,
  children,
}: {
  curriculumNav: React.ReactNode;
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      <button
        className="btn secondary small curriculum-drawer-toggle"
        type="button"
        onClick={() => setDrawerOpen(true)}
        style={{ position: "fixed", bottom: 88, right: 16, zIndex: 30 }}
      >
        ☰ Course contents
      </button>

      {drawerOpen && (
        <div
          className="curriculum-drawer open"
          id="curriculum-drawer"
          role="dialog"
          aria-label="Course contents"
        >
          <div className="panel">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "16px 18px",
                borderBottom: "1px solid var(--line)",
                position: "sticky",
                top: 0,
                background: "var(--paper-bright)",
              }}
            >
              <b style={{ fontSize: 14 }}>Course contents</b>
              <button
                className="btn secondary small"
                type="button"
                onClick={() => setDrawerOpen(false)}
              >
                Close
              </button>
            </div>
            <div onClick={() => setDrawerOpen(false)}>{curriculumNav}</div>
          </div>
        </div>
      )}

      <main className="wrap classroom" id="main" style={{ paddingTop: 32, paddingBottom: 64, gap: 32 }}>
        <aside aria-label="Curriculum">{curriculumNav}</aside>
        {children}
      </main>
    </>
  );
}
