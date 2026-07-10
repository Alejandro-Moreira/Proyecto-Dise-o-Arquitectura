# EcoFirma 🟢

Plataforma distribuida para la gestión documental y firma digital asíncrona de archivos.

## Autores: Andrew Vilcacundo y Alejandro Moreira

---

## 🏛️ Arquitectura del Sistema

El ecosistema de EcoFirma está compuesto por los siguientes servicios y componentes:

- **Frontend**: SPA construida en **React / Vite**, desplegada de forma estática.
- **API Gateway**: Enrutador Node.js centralizado que valida tokens JWT y redirige las peticiones a los microservicios correspondientes.
- **Users Service**: Servicio Node.js que gestiona el registro y login de usuarios utilizando una base de datos **PostgreSQL**.
- **Documents Service**: Servicio Node.js para la creación, lectura, actualización y eliminación de documentos. Utiliza caché en **Redis** para optimizar las consultas y publica mensajes en **RabbitMQ** para el flujo asíncrono.
- **Signature Worker**: Worker independiente Node.js que consume mensajes de la cola de RabbitMQ, simula el firmado criptográfico seguro (one-at-a-time con reintentos y cola de mensajes fallidos DLQ) y actualiza el estado de los documentos.
- **PostgreSQL**: Base de datos relacional compartida entre servicios (utilizando tablas aisladas).
- **Redis**: Caché en memoria de alto rendimiento para el listado y detalle de documentos.
- **RabbitMQ**: Message broker encargado del transporte y distribución de los mensajes de firma.
- **Prometheus & Grafana**: Stack de monitoreo encargado de recolectar y visualizar métricas de los contenedores y de la base de datos.

---

## 🚀 Despliegue en Producción

Los servicios se encuentran desplegados y listos para interactuar en producción:

- **Frontend (GitHub Pages)**: [https://alejandro-moreira.github.io/Proyecto-Dise-o-Arquitectura/](https://alejandro-moreira.github.io/Proyecto-Dise-o-Arquitectura/)
- **API Gateway (Render)**: `https://ecofirma-gateway.onrender.com`
- **Users Service (Render)**: `https://ecofirma-users-service.onrender.com`
- **Documents Service (Render)**: `https://ecofirma-documents-service.onrender.com`

> [!NOTE]
> **Limitación del Plan Gratuito (Render)**: 
> Los servicios en Render entran en suspensión tras 15 minutos de inactividad. La primera petición (cold start) puede demorar entre 30 y 50 segundos en responder mientras se despiertan los contenedores. Las siguientes peticiones serán instantáneas.

---

## 💻 Ejecución Local (Docker Compose)

Puedes levantar la infraestructura base, monitoreo, microservicios y worker localmente:

1. **Configurar variables de entorno**:
   ```bash
   cp .env.example .env
   ```
2. **Construir y levantar todo el stack**:
   ```bash
   docker compose up --build
   ```

### URLs Locales del Stack:
- **Frontend (UI)**: [http://localhost:5173](http://localhost:5173) o [http://localhost:5188](http://localhost:5188)
- **API Gateway**: [http://localhost:8081](http://localhost:8081)
- **RabbitMQ Admin**: [http://localhost:15673](http://localhost:15673) (User/Pass de tu `.env`)
- **Prometheus**: [http://localhost:9090](http://localhost:9090)
- **Grafana**: [http://localhost:3001](http://localhost:3001) (Credenciales: `admin` / `ecofirma_grafana_admin`)

---

## 📖 Guía de Uso de la Aplicación

### 1. Registro e Inicio de Sesión
- Puedes crear una cuenta nueva en la pestaña **Registro** ingresando tu Nombre, Email y Contraseña (mínimo 6 caracteres).
- O puedes usar directamente el usuario demo preconfigurado en la pestaña **Login**:
  - **Email**: `demo@ecofirma.test`
  - **Password**: `password123`

### 2. Subida y Validación de Documentos
- Al iniciar sesión, verás la sección **Subir documento para firma**.
- Admite archivos en formato **`.pdf`** y **`.docx`** (máx. 40MB).
- **Seguridad**: El sistema no se guía solo por la extensión del archivo, sino que valida los **magic bytes** (firma hexadecimal del archivo) en el backend. Si renombras un archivo `.png` a `.pdf`, el sistema lo detectará y rechazará para prevenir spoofing.

### 3. Estados del Documento y Acciones
Cada documento listado tiene estados específicos que controlan las acciones disponibles en la interfaz para proteger su ciclo de firma digital:

- **`PENDIENTE`**: Estado inicial del documento tras subirse.
  - **Firmar**: Habilitado. Envía el documento al worker para su firmado.
  - **Estado**: Muestra el estado actual.
  - **Actualizar**: Habilitado. Permite editar el título o reemplazar el archivo por una versión corregida.
  - **Eliminar**: Habilitado. Elimina el documento permanentemente (con confirmación).
  
- **`EN_PROCESO`**: El documento está siendo procesado por la cola.
  - **Acciones**: Todos los botones de **Firmar**, **Actualizar** y **Eliminar** se **deshabilitan** por diseño en la interfaz para proteger el flujo de firma y evitar que se modifique o borre el archivo a mitad del proceso.
  - *Nota en Producción*: Al no estar RabbitMQ/Worker desplegados en Render por limitación de recursos, al pulsar "Firmar", el estado cambiará permanentemente a `EN_PROCESO` de forma indefinida. En desarrollo local, el `Signature Worker` procesa la firma en 3 segundos y la pasa a `FIRMADO`.

- **`FIRMADO`**: Documento firmado criptográficamente de manera exitosa.
  - **Acciones**: Botones de **Firmar**, **Actualizar** y **Eliminar** deshabilitados permanentemente. El documento ya es inmutable y no se puede borrar ni modificar.

- **`ERROR`**: Si ocurre un fallo durante la simulación de firma criptográfica.
  - **Acciones**: Habilita nuevamente los botones **Actualizar** y **Eliminar** para que el usuario pueda corregir el archivo erróneo o eliminarlo de la plataforma.

---

## 🧪 Ejecución de Pruebas y Linter

Para verificar la integridad del código de forma local, puedes ejecutar los linters y pruebas en cualquiera de los microservicios:

```bash
# Ejemplo en Documents Service
cd documents-service
npm run lint  # Verificar calidad y formato del código
npm test      # Correr suite de pruebas unitarias/integración
```

El repositorio tiene configurado un flujo de integración continua (**GitHub Actions**) que corre el linter y todas las pruebas ante cada push para garantizar que la rama `main` siempre esté saludable.
