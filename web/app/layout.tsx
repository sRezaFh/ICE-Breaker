import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ICE Report Scraper',
  description: 'Trigger and watch an automated ICE report download run.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
