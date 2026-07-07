import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

function encodeBase64(value) {
  return btoa(unescape(encodeURIComponent(value)));
}

function App() {
  const [token, setToken] = useState(localStorage.getItem('ecofirma_token') || '');
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState('login');
  const [authForm, setAuthForm] = useState({
    nombre: 'Demo User',
    email: 'demo@ecofirma.test',
    password: 'password123',
  });
  const [docForm, setDocForm] = useState({
    titulo: 'Contrato de servicios',
    contenido: 'Contenido del documento de prueba para firma digital.',
  });
  const [documents, setDocuments] = useState([]);
  const [selectedStatus, setSelectedStatus] = useState(null);
  const [message, setMessage] = useState('');

  const headers = useMemo(() => ({
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }), [token]);

  async function request(path, options = {}) {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        ...headers,
        ...(options.headers || {}),
      },
    });

    if (response.status === 204) {
      return null;
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || data.message || 'Error en la solicitud');
    }
    return data;
  }

  async function submitAuth(event) {
    event.preventDefault();
    setMessage('');

    try {
      const path = authMode === 'register' ? '/api/users/register' : '/api/users/login';
      const payload = authMode === 'register'
        ? authForm
        : { email: authForm.email, password: authForm.password };
      const data = await request(path, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      if (authMode === 'register') {
        setMessage('Usuario registrado. Ahora inicia sesión.');
        setAuthMode('login');
        return;
      }

      setToken(data.token);
      setUser(data.user || null);
      localStorage.setItem('ecofirma_token', data.token);
      setMessage('Sesión iniciada correctamente.');
      await loadDocuments(data.token);
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function loadDocuments(forcedToken = token) {
    if (!forcedToken) {
      return;
    }

    const response = await fetch(`${API_URL}/api/documents`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${forcedToken}`,
      },
    });
    const data = await response.json().catch(() => []);

    if (!response.ok) {
      throw new Error(data.error || 'No se pudieron cargar documentos');
    }

    setDocuments(data);
  }

  async function createDocument(event) {
    event.preventDefault();
    setMessage('');

    try {
      await request('/api/documents', {
        method: 'POST',
        body: JSON.stringify({
          titulo: docForm.titulo,
          contenidoBase64: encodeBase64(docForm.contenido),
          autorId: user?.userId || 'demo-user',
        }),
      });
      setMessage('Documento creado y evento de firma publicado.');
      await loadDocuments();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function requestSignature(documentId) {
    setMessage('');
    try {
      await request('/api/signatures/process', {
        method: 'POST',
        body: JSON.stringify({ documentId }),
      });
      setMessage('Firma solicitada. El worker la procesará desde RabbitMQ.');
      await loadDocuments();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function getStatus(documentId) {
    setMessage('');
    try {
      const data = await request(`/api/documents/${documentId}/status`);
      setSelectedStatus(data);
    } catch (error) {
      setMessage(error.message);
    }
  }

  function logout() {
    setToken('');
    setUser(null);
    setDocuments([]);
    localStorage.removeItem('ecofirma_token');
  }

  useEffect(() => {
    if (token) {
      loadDocuments().catch((error) => setMessage(error.message));
    }
  }, []);

  return (
    <main className="shell">
      <section className="panel intro">
        <div>
          <p className="eyebrow">EcoFirma</p>
          <h1>Gestión documental y firma digital asíncrona</h1>
        </div>
        {token && <button type="button" onClick={logout}>Cerrar sesión</button>}
      </section>

      {!token && (
        <section className="panel">
          <div className="tabs">
            <button className={authMode === 'login' ? 'active' : ''} onClick={() => setAuthMode('login')} type="button">Login</button>
            <button className={authMode === 'register' ? 'active' : ''} onClick={() => setAuthMode('register')} type="button">Registro</button>
          </div>
          <form onSubmit={submitAuth} className="grid-form">
            {authMode === 'register' && (
              <label>
                Nombre
                <input value={authForm.nombre} onChange={(event) => setAuthForm({ ...authForm, nombre: event.target.value })} />
              </label>
            )}
            <label>
              Email
              <input value={authForm.email} onChange={(event) => setAuthForm({ ...authForm, email: event.target.value })} />
            </label>
            <label>
              Password
              <input type="password" value={authForm.password} onChange={(event) => setAuthForm({ ...authForm, password: event.target.value })} />
            </label>
            <button type="submit">{authMode === 'register' ? 'Registrar' : 'Entrar'}</button>
          </form>
        </section>
      )}

      {token && (
        <>
          <section className="panel">
            <h2>Crear documento</h2>
            <form onSubmit={createDocument} className="grid-form">
              <label>
                Título
                <input value={docForm.titulo} onChange={(event) => setDocForm({ ...docForm, titulo: event.target.value })} />
              </label>
              <label>
                Contenido
                <textarea value={docForm.contenido} onChange={(event) => setDocForm({ ...docForm, contenido: event.target.value })} />
              </label>
              <button type="submit">Crear documento</button>
            </form>
          </section>

          <section className="panel">
            <div className="section-head">
              <h2>Documentos</h2>
              <button type="button" onClick={() => loadDocuments()}>Actualizar</button>
            </div>
            <div className="table">
              {documents.map((doc) => (
                <article className="row" key={doc.id}>
                  <div>
                    <strong>{doc.titulo}</strong>
                    <span>{doc.id}</span>
                  </div>
                  <span className={`badge ${doc.status || doc.estado}`}>{doc.status || doc.estado}</span>
                  <button type="button" onClick={() => requestSignature(doc.id)}>Firmar</button>
                  <button type="button" onClick={() => getStatus(doc.id)}>Estado</button>
                </article>
              ))}
              {documents.length === 0 && <p className="empty">No hay documentos todavía.</p>}
            </div>
          </section>
        </>
      )}

      {selectedStatus && (
        <section className="panel compact">
          Estado del documento {selectedStatus.documentId}: <strong>{selectedStatus.status || selectedStatus.estado}</strong>
        </section>
      )}

      {message && <section className="panel compact">{message}</section>}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
