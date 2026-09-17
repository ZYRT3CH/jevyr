import type { Metadata } from 'next';
import './globals.css';
import { DAEMON_ORIGIN_META, serverDaemonOrigin } from '@/lib/daemon-origin';

export const metadata: Metadata = {
  title: 'Jevyr · Chamber',
  description: 'A live, sealed surface for Jevyr cases and their evidence.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head><meta name={DAEMON_ORIGIN_META} content={serverDaemonOrigin()} /><link rel="icon" href="/favicon.svg" type="image/svg+xml" /></head>
      <body>{children}</body>
    </html>
  );
}
