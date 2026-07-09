import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API_URL = import.meta.env.VITE_API_URL
  || (import.meta.env.PROD ? 'https://ecofirma-gateway.onrender.com' : 'http://localhost:8081');

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
    titulo: '',
    contenido: '',
  });
  const [selectedFile, setSelectedFile] = useState(null);
  const [editingDoc, setEditingDoc] = useState(null);
  const [editingFile, setEditingFile] = useState(null);
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

    if (!selectedFile) {
      setMessage('Por favor, selecciona un archivo (.pdf o .docx) para subir.');
      return;
    }

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('autorId', user?.userId || 'demo-user');
      if (docForm.titulo) {
        formData.append('titulo', docForm.titulo);
      }

      const response = await fetch(`${API_URL}/api/documents`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`
        },
        body: formData
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Error al subir el archivo');
      }

      setMessage('Documento subido y evento de firma publicado con éxito.');
      setDocForm({ ...docForm, titulo: '' });
      setSelectedFile(null);
      document.getElementById('file-input').value = '';
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

  async function deleteDocument(documentId) {
    if (!window.confirm('¿Estás seguro de que deseas eliminar este documento? Esta acción no se puede deshacer.')) {
      return;
    }
    setMessage('');
    try {
      await request(`/api/documents/${documentId}`, {
        method: 'DELETE',
      });
      setMessage('Documento eliminado con éxito.');
      await loadDocuments();
    } catch (error) {
      setMessage(`Error al eliminar: ${error.message}`);
    }
  }

  async function updateDocument(event) {
    event.preventDefault();
    if (!editingDoc) return;
    setMessage('');

    try {
      let contenidoBase64 = undefined;
      if (editingFile) {
        contenidoBase64 = await fileToBase64(editingFile);
      }

      const body = {
        titulo: editingDoc.titulo,
      };
      if (contenidoBase64 !== undefined) {
        body.contenidoBase64 = contenidoBase64;
      }

      await request(`/api/documents/${editingDoc.id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });

      setMessage('Documento actualizado con éxito.');
      setEditingDoc(null);
      setEditingFile(null);
      await loadDocuments();
    } catch (error) {
      setMessage(`Error al actualizar: ${error.message}`);
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = error => reject(error);
    });
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
            <h2>Subir documento para firma</h2>
            <form onSubmit={createDocument} className="grid-form">
              <label>
                Título (Opcional)
                <input value={docForm.titulo} onChange={(event) => setDocForm({ ...docForm, titulo: event.target.value })} placeholder="Dejar vacío para usar nombre del archivo" />
              </label>
              <label>
                Archivo (.pdf, .docx - máx. 40MB)
                <input id="file-input" type="file" accept=".pdf,.docx" onChange={(event) => setSelectedFile(event.target.files[0] || null)} />
              </label>
              <button type="submit">Subir y procesar firma</button>
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
                  <button type="button" onClick={() => requestSignature(doc.id)} disabled={(doc.status || doc.estado) === 'FIRMADO' || (doc.status || doc.estado) === 'EN_PROCESO'}>Firmar</button>
                  <button type="button" onClick={() => getStatus(doc.id)}>Estado</button>
                  <button type="button" className="secondary" onClick={() => setEditingDoc(doc)} disabled={(doc.status || doc.estado) === 'FIRMADO' || (doc.status || doc.estado) === 'EN_PROCESO'}>Actualizar</button>
                  <button type="button" className="danger" onClick={() => deleteDocument(doc.id)} disabled={(doc.status || doc.estado) === 'FIRMADO' || (doc.status || doc.estado) === 'EN_PROCESO'}>Eliminar</button>
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

      {editingDoc && (
        <div className="modal-overlay">
          <section className="panel modal-content">
            <h2>Actualizar Documento</h2>
            <form onSubmit={updateDocument} className="grid-form">
              <label>
                Título
                <input value={editingDoc.titulo} onChange={(event) => setEditingDoc({ ...editingDoc, titulo: event.target.value })} required />
              </label>
              <label>
                Reemplazar Archivo (Opcional, .pdf, .docx)
                <input id="edit-file-input" type="file" accept=".pdf,.docx" onChange={(event) => setEditingFile(event.target.files[0] || null)} />
              </label>
              <div className="button-group">
                <button type="submit">Guardar Cambios</button>
                <button type="button" className="secondary" onClick={() => { setEditingDoc(null); setEditingFile(null); }}>Cancelar</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
