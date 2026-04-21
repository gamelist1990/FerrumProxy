import { useState } from "react";
import { t } from "../lang";
import "./Login.css";

interface LoginProps {
  onLogin: (username: string, password: string) => Promise<void>;
  isSetup?: boolean;
}

export function Login({ onLogin, isSetup = false }: LoginProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!username || !password) {
      setError("Username and password are required");
      return;
    }

    if (isSetup) {
      if (password.length < 8) {
        setError(t("passwordTooShort"));
        return;
      }
      if (password !== confirmPassword) {
        setError(t("passwordMismatch"));
        return;
      }
    }

    setLoading(true);
    try {
      await onLogin(username, password);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("loginFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-box">
        <h1>{isSetup ? t("setupTitle") : t("loginTitle")}</h1>
        {isSetup && (
          <p className="login-description">{t("setupDescription")}</p>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="username">{t("username")}</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={loading}
              autoFocus
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">{t("password")}</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
            />
          </div>

          {isSetup && (
            <div className="form-group">
              <label htmlFor="confirmPassword">{t("confirmPassword")}</label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={loading}
              />
            </div>
          )}

          {error && <div className="error-message">{error}</div>}

          <button type="submit" disabled={loading}>
            {loading ? "..." : isSetup ? t("setupButton") : t("loginButton")}
          </button>
        </form>
      </div>
    </div>
  );
}
