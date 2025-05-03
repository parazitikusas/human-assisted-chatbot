## System Overview

The working system consists of **four running applications**:

1. **Main Kodee Backend Architecture**  
   Repository: [hostinger/kodee-demo](https://github.com/hostinger/kodee-demo)  
   > ⚠️ When running this application, make sure to **add appropriate CORS rules** to allow requests from your machine.

2. **Three Applications from This Repository**:
   - **Client Frontend**
   - **Middleware**
     - **Middleware Backend**
     - **Middleware Frontend** (for CS Specialists)

---

## Launch Instructions

### 1. Client Frontend

A standard React app. To start:

```bash
cd kodee-client
npm install
npm run dev
```


### 2. Middleware frontend

Also a React app. To start:

```bash
cd cs-specialist-ui
npm install
npm run dev
```

### 3. Middleware Backend

A Node.js server. To start:

```bash
cd kodee-middleware
npm install
node server.js
```
