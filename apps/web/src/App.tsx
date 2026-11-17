import { useEffect, useState } from 'react';
import type { SessionUser } from '@mip/core/types';
import { api } from './api';
import { DashboardPage } from './components/DashboardPage';
import { LoginPage } from './components/LoginPage';

export function App() {
  // undefined = still checking the session cookie
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);

  useEffect(() => {
    api.me().then(setUser, () => setUser(null));
  }, []);

  if (user === undefined) return <div className="boot">Loading…</div>;
  if (user === null) return <LoginPage onLogin={setUser} />;
  return <DashboardPage user={user} onLoggedOut={() => setUser(null)} />;
}
