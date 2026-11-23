import { useEffect, useState } from "react";
import { AuthContext } from "./auth-context";
import api from "../services/api";

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    api.get("/auth/me")
      .then(({ data }) => {
        if (active) setUser(data.user);
      })
      .catch(() => {
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  async function login(credentials) {
    const { data } = await api.post("/auth/login", credentials);
    setUser(data.user);
    return data.user;
  }

  async function register(details) {
    const { data } = await api.post("/auth/register", details);
    setUser(data.user);
    return data.user;
  }

  async function logout() {
    await api.post("/auth/logout").catch(() => undefined);
    setUser(null);
  }

  function updateUser(profile) {
    setUser((current) => ({ ...current, ...profile }));
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}
