import base64
import json
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, status

from .config import Settings, get_settings


@dataclass(frozen=True)
class Principal:
    id: str
    name: str
    email: str
    roles: frozenset[str]
    is_local_demo: bool = False


ROLE_ALIASES = {
    "administrator": "admin",
    "educator": "teacher",
    "instructor": "teacher",
    "learner": "student",
}


def _decode_principal(value: str) -> dict:
    try:
        padded = value + "=" * (-len(value) % 4)
        payload = base64.b64decode(padded, validate=True)
        decoded = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="The authenticated principal header is invalid.",
        ) from exc
    if not isinstance(decoded, dict):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="The authenticated principal header is invalid.",
        )
    return decoded


def principal_from_request(request: Request, settings: Settings) -> Principal:
    if not settings.is_production:
        return Principal(
            id="local-demo",
            name="Local demo user",
            email="",
            roles=frozenset({"admin", "teacher", "student", "owner"}),
            is_local_demo=True,
        )

    encoded = request.headers.get(settings.principal_header_name, "")
    if not encoded:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Microsoft Entra authentication is required.",
        )
    payload = _decode_principal(encoded)
    claims = payload.get("claims")
    if not isinstance(claims, list):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="The authenticated principal has no claims.",
        )

    values: dict[str, list[str]] = {}
    for claim in claims:
        if not isinstance(claim, dict):
            continue
        claim_type = str(claim.get("typ", "")).lower()
        claim_value = str(claim.get("val", "")).strip()
        if claim_type and claim_value:
            values.setdefault(claim_type, []).append(claim_value)

    role_type = str(payload.get("role_typ", "")).lower()
    role_values = values.get(role_type, []) if role_type else []
    for claim_type, claim_values in values.items():
        if claim_type in {"roles", "role"} or claim_type.endswith("/claims/role"):
            role_values.extend(claim_values)
    roles = frozenset(
        ROLE_ALIASES.get(role.strip().lower(), role.strip().lower())
        for role in role_values
        if role.strip()
    )
    principal_id = (
        request.headers.get("x-ms-client-principal-id", "").strip()
        or next(
            (
                item
                for claim_type, claim_values in values.items()
                if claim_type in {"oid", "sub"}
                or claim_type.endswith("/claims/nameidentifier")
                for item in claim_values
            ),
            "",
        )
    )
    email = next(
        (
            item
            for claim_type, claim_values in values.items()
            if claim_type in {"email", "preferred_username", "upn"}
            or claim_type.endswith("/claims/emailaddress")
            for item in claim_values
        ),
        "",
    ).lower()
    name = (
        request.headers.get("x-ms-client-principal-name", "").strip()
        or next(
            (
                item
                for claim_type, claim_values in values.items()
                if claim_type == "name" or claim_type.endswith("/claims/name")
                for item in claim_values
            ),
            "",
        )
        or email
        or principal_id
    )
    if not principal_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The authenticated principal is missing an identifier.",
        )
    return Principal(
        id=principal_id,
        name=name,
        email=email,
        roles=roles,
    )


def get_principal(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> Principal:
    principal = getattr(request.state, "principal", None)
    if principal is None:
        principal = principal_from_request(request, settings)
        request.state.principal = principal
    return principal


def require_roles(*allowed_roles: str):
    allowed = frozenset(allowed_roles)

    def dependency(principal: Principal = Depends(get_principal)) -> Principal:
        if not principal.roles.intersection(allowed):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This operation is not allowed for the signed-in role.",
            )
        return principal

    return dependency
