import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './AuthStatus.css';

export default function AuthStatus({ defaultExpanded = false }) {
  const { user, loading, isAuthenticated, signInWithEmail, signUpWithEmail, signOut, supabaseConfigured } = useAuth();
  const [showAuth, setShowAuth] = useState(defaultExpanded);
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  if (!supabaseConfigured) {
    return (
      <span className="auth-status auth-status--disabled" title="Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY to enable login">
        Login (Supabase not configured)
      </span>
    );
  }

  if (loading) {
    return <span className="auth-status">Loading…</span>;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    try {
      if (isSignUp) {
        await signUpWithEmail(email, password);
        setMessage('Check your email to confirm your account.');
      } else {
        await signInWithEmail(email, password);
        setShowAuth(false);
        setEmail('');
        setPassword('');
      }
    } catch (err) {
      setError(err.message || 'Auth failed');
    }
  };

  if (isAuthenticated) {
    return (
      <div className="auth-status auth-status--signed-in">
        <span className="auth-status__email" title={user?.email}>{user?.email}</span>
        <button type="button" className="auth-status__btn auth-status__btn--out" onClick={() => signOut()}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="auth-status">
      <button type="button" className="auth-status__btn auth-status__btn--in" onClick={() => setShowAuth(!showAuth)}>
        Sign in
      </button>
      {showAuth && (
        <form className="auth-status__form" onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="auth-status__input"
            autoComplete="email"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="auth-status__input"
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
          />
          {error && <div className="auth-status__error">{error}</div>}
          {message && <div className="auth-status__message">{message}</div>}
          <div className="auth-status__actions">
            <button type="submit" className="auth-status__btn auth-status__btn--submit">
              {isSignUp ? 'Sign up' : 'Sign in'}
            </button>
            <button
              type="button"
              className="auth-status__btn auth-status__btn--switch"
              onClick={() => { setIsSignUp(!isSignUp); setError(''); setMessage(''); }}
            >
              {isSignUp ? 'Already have an account? Sign in' : 'Create account'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
