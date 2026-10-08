import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import SessionProvider from '@/components/auth/SessionProvider';

export const metadata: Metadata = {
  title: 'Nexus',
  description: 'Learn history through an interactive causal graph.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
