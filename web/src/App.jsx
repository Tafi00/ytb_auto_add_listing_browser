import { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Public from './pages/Public';
import './public.css';

const api = {
  token: localStorage.getItem('token'),

  setToken(token) {
    this.token = token;
    if (token) localStorage.setItem('token', token);
    else localStorage.removeItem('token');
  },

  async fetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
        ...options.headers
      }
    });
    if (res.status === 401) {
      this.setToken(null);
      window.location.href = '/login';
      throw new Error('Unauthorized');
    }
    return res;
  },

  async login(username, password) {
    const res = await this.fetch('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    this.setToken(data.token);
    return data;
  },

  async verify() {
    const res = await this.fetch('/api/verify');
    return res.ok;
  },

  async getProfile() {
    const res = await this.fetch('/api/profile');
    return res.json();
  },

  async getWorkerStatus() {
    const res = await this.fetch('/api/worker-status');
    return res.json();
  },

  async getJobConfig() {
    const res = await this.fetch('/api/job-config');
    return res.json();
  },

  async saveJobConfig(url) {
    const res = await this.fetch('/api/job-config', {
      method: 'PUT',
      body: JSON.stringify({ url })
    });
    return res.json();
  },



  logout() {
    this.setToken(null);
  }
};

export { api };

function App() {
  const [isAuth, setIsAuth] = useState(null);
  const [user, setUser] = useState(null);

  useEffect(() => {
    const checkAuth = async () => {
      if (!api.token) { setIsAuth(false); return; }
      try {
        const valid = await api.verify();
        setIsAuth(valid);
        if (valid) setUser(localStorage.getItem('username'));
      } catch { setIsAuth(false); }
    };
    checkAuth();
  }, []);

  const handleLogin = (userData) => {
    setIsAuth(true);
    setUser(userData.username);
    localStorage.setItem('username', userData.username);
  };

  const handleLogout = () => {
    api.logout();
    setIsAuth(false);
    setUser(null);
    localStorage.removeItem('username');
  };

  if (isAuth === null) {
    return (
      <div className="loading-page">
        <div className="spinner"></div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<Public />} />
      <Route path="/login" element={isAuth ? <Navigate to="/admin" /> : <Login onLogin={handleLogin} />} />
      <Route path="/admin/*" element={isAuth ? <Dashboard user={user} onLogout={handleLogout} /> : <Navigate to="/login" />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}

export default App;
