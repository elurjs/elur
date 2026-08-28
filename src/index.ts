// Elur — Public Library Entry Point
// Single entry for the compiled library. Import from here as an npm consumer:
//   import { signal, html, ElurComponent, mount } from "@elurjs/core";

// --- Values ---
export {
    // Reactivity
    Signal,
    signal,
    effect,
    computed,
    batch,
    watch,
    untrack,
    nextTick,
    // Templates
    html,
    repeat,
    raw,
    ref,
    showWhen,
    portal,
    createPortalOutlet,
    portalOutlet,
    provideOutlet,
    injectOutlet,
    createErrorBoundary,
    transition,
    ELUR_TEMPLATE_DESCRIPTOR,
    ELUR_RENDER_PROTOCOL,
    templateFeatures,
    // Components
    mount,
    ElurComponent,
    // Store
    createStore,
    persistPlugin,
    loggerPlugin,
    guardPlugin,
    bridgePlugin,
    // Router
    createRouter,
    RouterView,
    Link,
    elurRouter,
    RouterKey,
    _hasActiveRouter,
    // Async / Lazy
    suspend,
    lazy,
    // Dependency Injection
    provide,
    inject,
    createInjectionKey,
    // Forms
    elurField,
    elurFieldArray,
    createForm,
    required,
    minLength,
    maxLength,
    email,
    pattern,
    min,
    max,
    createValidator,
    validators,
    extendValidators,
} from "./elur/index.js";

// --- Types ---
export type {
    // Reactivity
    WatchOptions,
    // Templates
    ElurTemplate,
    ElurMountHandle,
    TemplateBindingContext,
    TemplateDescriptor,
    ElurRenderProtocol,
    ServerRenderProtocolContext,
    DomProtocolContext,
    HydrationProtocolContext,
    MountOptions,
    KeyedList,
    ElurRef,
    PortalOutlet,
    ErrorFallback,
    TransitionOptions,
    TransitionContent,
    // Store
    Store,
    StoreSignals,
    ElurPlugin,
    // Router
    Router,
    NamedRouteLocation,
    RouteLocation,
    RouteRecord,
    RouterOptions,
    NavigationGuard,
    NavigationGuardResult,
    AfterEachHook,
    ResolvedRoute,
    ScrollPosition,
    ScrollBehavior,
    RouterMode,
    NavigationDirection,
    NavigationIntent,
    NavigationAction,
    NavigateOptions,
    // Async
    SuspenseOptions,
    // Dependency Injection
    InjectionKey,
    // Forms
    DeepPartial,
    Validator,
    ValidateOn,
    FieldState,
    FieldArrayState,
    FieldErrors,
    FormState,
    FormOptions,
    ValidatorsBase,
    ElurChildren,
} from "./elur/index.js";
