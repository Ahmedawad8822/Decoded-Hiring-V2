import type { SVGProps } from "react";

const paths = {
  home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
  content: "M5 3h10l4 4v14H5ZM14 3v5h5M8 12h8M8 16h6",
  courses: "m2 8 10-5 10 5-10 5Zm4 2v7c4 3 8 3 12 0v-7M22 8v9",
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2M7 14h3M14 14h3M7 18h3",
  leads: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  sparkles: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4M18 4h4",
  knowledge: "M12 6c-3-3-7-3-10-2v15c4-1 7-1 10 2 3-3 6-3 10-2V4c-3-1-7-1-10 2Zm0 0v15",
  memory: "M9 3a3 3 0 0 0-3 3 4 4 0 0 0-3 6 4 4 0 0 0 3 6 3 3 0 0 0 6 1V6a3 3 0 0 0-3-3Zm6 0a3 3 0 0 1 3 3 4 4 0 0 1 3 6 4 4 0 0 1-3 6 3 3 0 0 1-6 1M6 6l2 2M6 18l2-2M18 6l-2 2M18 18l-2-2",
  audit: "M9 3H5v18h14V3h-4M9 2h6v4H9ZM8 11h8M8 15h8M8 18h4",
  security: "m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Zm-4 10 3 3 5-6",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M6 18 18 6",
  external: "M14 3h7v7M21 3 10 14M10 3H3v18h18v-7",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  up: "M12 20V4m-6 6 6-6 6 6",
  down: "M12 4v16m-6-6 6 6 6-6",
  plus: "M12 4v16M4 12h16",
  edit: "m15 4 5 5M3 21l5-1L21 7a2 2 0 0 0-5-5L3 15Z",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  archive: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
  upload: "M12 16V3m-5 5 5-5 5 5M3 15v6h18v-6",
  clock: "M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  check: "m5 12 4 4L19 6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  inbox: "M3 13h5l2 3h4l2-3h5M3 13l3-9h12l3 9v7H3Z",
  orders: "M5 3h14v18l-3-2-4 2-4-2-3 2ZM8 7h8M8 11h8M8 15h4",
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name]} /></svg>;
}
