// Package bridge provides a gomobile-compatible wrapper around tsnet,
// allowing the DropBeam Android app to embed a Tailscale node without
// requiring the standalone Tailscale app.
//
// Build the .aar for Android:
//
//	go install golang.org/x/mobile/cmd/gomobile@latest
//	gomobile init
//	gomobile bind -target=android -androidapi 26 -o libtailscale.aar .
//
// Place the resulting libtailscale.aar in android/app/libs/
package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

var (
	srv     *tsnet.Server
	srvMu   sync.Mutex
	httpSrv *http.Server

	// ReceiveDir is where incoming files are saved.
	// Set before calling TsnetStart.
	ReceiveDir string
)

// Peer represents a device on the tailnet.
type Peer struct {
	Name   string `json:"name"`
	IP     string `json:"ip"`
	Online bool   `json:"online"`
	OS     string `json:"os"`
}

// TsnetStart boots an embedded Tailscale node.
// dataDir: persistent state directory (e.g. context.filesDir + "/tailscale")
// controlURL: Headscale server URL (e.g. "http://your-ip:8080")
// authKey: pre-auth key from POST /devices/register
// hostname: device name on the tailnet
//
// Returns empty string on success or an error message.
func TsnetStart(dataDir, controlURL, authKey, hostname string) string {
	srvMu.Lock()
	defer srvMu.Unlock()

	if srv != nil {
		return "already running"
	}

	os.MkdirAll(dataDir, 0700)

	s := &tsnet.Server{
		Dir:        dataDir,
		Hostname:   hostname,
		ControlURL: controlURL,
		AuthKey:    authKey,
		Ephemeral:  false,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	status, err := s.Up(ctx)
	if err != nil {
		s.Close()
		return fmt.Sprintf("tsnet.Up: %v", err)
	}

	_ = status
	srv = s
	return ""
}

// TsnetStop shuts down the embedded Tailscale node.
func TsnetStop() {
	srvMu.Lock()
	defer srvMu.Unlock()

	if httpSrv != nil {
		httpSrv.Close()
		httpSrv = nil
	}
	if srv != nil {
		srv.Close()
		srv = nil
	}
}

// TsnetGetIP returns this node's Tailscale IP address.
func TsnetGetIP() string {
	srvMu.Lock()
	s := srv
	srvMu.Unlock()

	if s == nil {
		return ""
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	status, err := s.Up(ctx)
	if err != nil {
		return ""
	}
	for _, addr := range status.TailscaleIPs {
		if addr.Is4() {
			return addr.String()
		}
	}
	return ""
}

// TsnetGetPeers returns a JSON array of peers on the tailnet.
func TsnetGetPeers() string {
	srvMu.Lock()
	s := srv
	srvMu.Unlock()

	if s == nil {
		return "[]"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	st, err := s.Up(ctx)
	if err != nil {
		return "[]"
	}

	var peers []Peer
	for _, p := range st.Peer {
		if len(p.TailscaleIPs) == 0 {
			continue
		}
		peers = append(peers, Peer{
			Name:   p.HostName,
			IP:     p.TailscaleIPs[0].String(),
			Online: p.Online,
			OS:     p.OS,
		})
	}

	data, _ := json.Marshal(peers)
	return string(data)
}

// TsnetStartHTTPServer starts an HTTP file-receive server on the given port,
// listening on the Tailscale interface. Peers send files via:
//
//	POST http://<thisIP>:<port>/receive  (multipart/form-data, field "file")
//
// Files are saved to ReceiveDir.
func TsnetStartHTTPServer(port int) string {
	srvMu.Lock()
	s := srv
	srvMu.Unlock()

	if s == nil {
		return "tailscale not running"
	}

	ln, err := s.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return fmt.Sprintf("listen: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/receive", handleReceive)
	mux.HandleFunc("/info", handleInfo)

	httpSrv = &http.Server{Handler: mux}
	go httpSrv.Serve(ln)

	return ""
}

func handleReceive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 10<<30) // 10 GB max

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, fmt.Sprintf("form file: %v", err), http.StatusBadRequest)
		return
	}
	defer file.Close()

	dir := ReceiveDir
	if dir == "" {
		dir = os.TempDir()
	}
	os.MkdirAll(dir, 0755)

	destPath := filepath.Join(dir, header.Filename)
	// avoid overwriting
	if _, err := os.Stat(destPath); err == nil {
		base := header.Filename
		ext := filepath.Ext(base)
		name := base[:len(base)-len(ext)]
		for i := 1; ; i++ {
			destPath = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", name, i, ext))
			if _, err := os.Stat(destPath); os.IsNotExist(err) {
				break
			}
		}
	}

	out, err := os.Create(destPath)
	if err != nil {
		http.Error(w, fmt.Sprintf("create: %v", err), http.StatusInternalServerError)
		return
	}
	defer out.Close()

	written, err := io.Copy(out, file)
	if err != nil {
		http.Error(w, fmt.Sprintf("write: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("received %s (%d bytes) from %s", header.Filename, written, r.RemoteAddr)
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"ok":true,"file":"%s","bytes":%d}`, header.Filename, written)
}

func handleInfo(w http.ResponseWriter, r *http.Request) {
	ip := TsnetGetIP()
	srvMu.Lock()
	name := ""
	if srv != nil {
		name = srv.Hostname
	}
	srvMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"name":"%s","ip":"%s"}`, name, ip)
}

// DialPeer creates a TCP connection to another peer's Tailscale IP.
// Used for custom transfer protocols if needed.
func DialPeer(peerIP string, port int) (net.Conn, error) {
	srvMu.Lock()
	s := srv
	srvMu.Unlock()

	if s == nil {
		return nil, fmt.Errorf("tailscale not running")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	return s.Dial(ctx, "tcp", fmt.Sprintf("%s:%d", peerIP, port))
}
