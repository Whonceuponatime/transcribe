import React from 'react';
import AuthStatus from './AuthStatus';
import './SignInGate.css';

/**
 * Full-page gate shown when the user must sign in before using the app.
 * Unverified (signed-out) users cannot access the tools.
 */
export default function SignInGate() {
  return (
    <div className="sign-in-gate">
      <div className="sign-in-gate__card">
        <div className="sign-in-gate__cta">
          <h1 className="sign-in-gate__title">🃏 Jack of clubs</h1>
          <p className="sign-in-gate__subtitle">
            Comprehensive media processing suite
          </p>
          <p className="sign-in-gate__message">
            Sign in to use transcription, metadata tools, image conversion, and more.
          </p>
        </div>
        <div className="sign-in-gate__form-wrap">
          <AuthStatus defaultExpanded />
        </div>
      </div>
    </div>
  );
}
