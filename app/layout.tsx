import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "像风一样 · 音乐密码四关练习",
  description: "导入 MusicXML，自动生成听、和弦、伴奏与双手演奏四个 PartyKeys 练习关卡。",
  icons: {
    icon: "/partykeys-keyboard.png",
    shortcut: "/partykeys-keyboard.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
