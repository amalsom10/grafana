package middleware

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/grafana/grafana/pkg/infra/tracing"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	trace "go.opentelemetry.io/otel/trace"

	"gopkg.in/macaron.v1"
)

type contextKey struct{}

var routeOperationNameKey = contextKey{}

// ProvideRouteOperationName creates a named middleware responsible for populating
// the context with the route operation name that can be used later in the request pipeline.
// Implements routing.RegisterNamedMiddleware.
func ProvideRouteOperationName(name string) macaron.Handler {
	return func(res http.ResponseWriter, req *http.Request, c *macaron.Context) {
		ctx := context.WithValue(c.Req.Context(), routeOperationNameKey, name)
		c.Req = c.Req.WithContext(ctx)
	}
}

// RouteOperationNameFromContext receives the route operation name from context, if set.
func RouteOperationNameFromContext(ctx context.Context) (string, bool) {
	if val := ctx.Value(routeOperationNameKey); val != nil {
		op, ok := val.(string)
		return op, ok
	}

	return "", false
}

func RequestTracing() macaron.Handler {
	return func(res http.ResponseWriter, req *http.Request, c *macaron.Context) {
		if strings.HasPrefix(c.Req.URL.Path, "/public/") ||
			c.Req.URL.Path == "robots.txt" {
			c.Next()
			return
		}

		rw := res.(macaron.ResponseWriter)

		wireContext := otel.GetTextMapPropagator().Extract(req.Context(), propagation.HeaderCarrier(req.Header))
		ctx, span := tracing.Tracer.Start(req.Context(), fmt.Sprintf("HTTP %s %s", req.Method, req.URL.Path), trace.WithLinks(trace.LinkFromContext(wireContext)))

		c.Req = req.WithContext(ctx)
		c.Map(c.Req)

		c.Next()

		// Only call span.End when a route operation name have been set,
		// meaning that not set the span would not be reported.
		if routeOperation, exists := RouteOperationNameFromContext(c.Req.Context()); exists {
			defer span.End()
			span.SetName(fmt.Sprintf("HTTP %s %s", req.Method, routeOperation))
		}

		status := rw.Status()

		span.SetAttributes(attribute.Int("HTTP response status code", status))
		span.SetAttributes(attribute.String("HTTP request URI", req.RequestURI))
		span.SetAttributes(attribute.String("HTTP request method", req.Method))
		if status >= 400 {
			span.SetStatus(codes.Error, fmt.Sprintf("error with HTTP status code %s", strconv.Itoa(status)))
		}
	}
}
